import type { Collection, Db, Document } from 'mongodb';
import type { QueryRequest, QueryResult, QueryWritePreview } from '../../shared/types.js';
import {
  COLLECTION_WRITE_METHODS,
  DB_WRITE_METHODS,
  WRITE_COMMANDS
} from '../../shared/writeOps.js';
import { EJSON, SHADOWED_GLOBALS, buildHelpers } from './bsonEval.js';
import { connectionIsReadOnly } from './guards.js';
import { getClient } from './pool.js';

const HARD_DOCUMENT_CAP = 20_000;

const AsyncFunction = Object.getPrototypeOf(async function noop() {
  /* used only for its constructor */
}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

const SHELL_ALIASES: Record<string, string> = {
  count: 'countDocuments',
  getIndexes: 'indexes',
  getIndexKeys: 'indexes',
  insert: 'insertOne',
  remove: 'deleteMany',
  update: 'updateMany',
  save: 'insertOne',
  totalDocuments: 'countDocuments',
  renameCollection: 'rename'
};

/**
 * How a query's writes should be treated: performed, counted without being
 * performed (a dry run), or refused outright (a read-only connection).
 */
type WriteMode = 'allow' | 'preview' | 'refuse';

interface WriteGuard {
  mode: WriteMode;
  /** Why writes are refused, phrased for the person who typed the query. */
  refusal: string;
  record: (entry: QueryWritePreview) => void;
}

/** Counts what a write would have touched, instead of writing. */
function previewWrite(
  collection: Collection,
  method: string,
  args: unknown[],
  guard: WriteGuard
): unknown {
  const namespace = `${collection.dbName}.${collection.collectionName}`;
  const note = (text: string) => ({ method, namespace, affected: null, note: text });

  const countMatching = async (single: boolean) => {
    const filter = (args[0] ?? {}) as Document;
    const matched = await collection.countDocuments(filter, { maxTimeMS: 15_000 });
    const affected = single ? Math.min(matched, 1) : matched;
    guard.record({
      method,
      namespace,
      affected,
      note:
        single && matched > 1
          ? `${matched.toLocaleString()} documents match; only the first would be touched`
          : undefined
    });
    return { acknowledged: false, dryRun: true, matchedCount: affected };
  };

  switch (method) {
    case 'deleteMany':
    case 'remove':
    case 'updateMany':
    case 'update':
      return countMatching(false);
    case 'deleteOne':
    case 'updateOne':
    case 'replaceOne':
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete':
      return countMatching(true);
    case 'insertOne':
    case 'insert':
    case 'save':
      guard.record({ method, namespace, affected: 1 });
      return { acknowledged: false, dryRun: true, insertedCount: 1 };
    case 'insertMany': {
      const documents = Array.isArray(args[0]) ? (args[0] as unknown[]).length : 0;
      guard.record({ method, namespace, affected: documents });
      return { acknowledged: false, dryRun: true, insertedCount: documents };
    }
    case 'bulkWrite': {
      const operations = Array.isArray(args[0]) ? (args[0] as unknown[]).length : 0;
      guard.record(note(`${operations.toLocaleString()} bulk operations`));
      return { acknowledged: false, dryRun: true };
    }
    case 'drop':
      guard.record(note('the whole collection would be dropped'));
      return true;
    default:
      guard.record(note('would change the collection'));
      return { acknowledged: false, dryRun: true };
  }
}

/**
 * Wraps a driver Collection so mongosh-style method names resolve, while
 * everything else falls through to the real driver API (including cursors,
 * which keeps `.sort().skip().limit()` chaining intact). Writes are diverted
 * according to the guard.
 */
function wrapCollection(collection: Collection, guard: WriteGuard): Collection {
  return new Proxy(collection, {
    get(target, property, receiver) {
      const key = typeof property === 'string' ? property : '';
      const resolved =
        key in target ? key : (SHELL_ALIASES[key] as string | undefined) ?? key;

      if (guard.mode !== 'allow' && COLLECTION_WRITE_METHODS.has(resolved)) {
        return (...args: unknown[]) => {
          if (guard.mode === 'refuse') throw new Error(guard.refusal);
          return previewWrite(target, resolved, args, guard);
        };
      }

      if (resolved === 'aggregate' && guard.mode !== 'allow') {
        return (...args: unknown[]) => aggregateWithoutOutput(target, args, guard);
      }

      const value = Reflect.get(target, resolved, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Collection;
}

/**
 * `$out` and `$merge` write the pipeline's output. Dropping those stages leaves
 * a pipeline that shows what would have been written without writing it.
 */
function aggregateWithoutOutput(collection: Collection, args: unknown[], guard: WriteGuard): unknown {
  const pipeline = Array.isArray(args[0]) ? (args[0] as Document[]) : [];
  const writes = pipeline.filter((stage) => stage && ('$out' in stage || '$merge' in stage));
  if (writes.length === 0) {
    return collection.aggregate(pipeline, args[1] as never);
  }
  if (guard.mode === 'refuse') throw new Error(guard.refusal);
  const stage = '$out' in writes[0] ? '$out' : '$merge';
  guard.record({
    method: `aggregate ${stage}`,
    namespace: `${collection.dbName}.${collection.collectionName}`,
    affected: null,
    note: 'the pipeline output would be written to a collection'
  });
  return collection.aggregate(
    pipeline.filter((entry) => !writes.includes(entry)),
    args[1] as never
  );
}

function wrapDb(
  db: Db,
  siblingFactory: (name: string) => Db,
  guard: WriteGuard
): Db & Record<string, unknown> {
  const extras: Record<string, unknown> = {
    getCollection: (name: string) => wrapCollection(db.collection(name), guard),
    getSiblingDB: (name: string) => wrapDb(siblingFactory(name), siblingFactory, guard),
    getName: () => db.databaseName,
    getCollectionNames: async () =>
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    runCommand: (command: Record<string, unknown>) => runGuardedCommand(db, command, guard),
    command: (command: Record<string, unknown>) => runGuardedCommand(db, command, guard),
    stats: () => db.command({ dbStats: 1 })
  };

  return new Proxy(db, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver);
      if (property in extras) return extras[property];

      if (guard.mode !== 'allow' && DB_WRITE_METHODS.has(property)) {
        return (...args: unknown[]) => {
          if (guard.mode === 'refuse') throw new Error(guard.refusal);
          guard.record({
            method: property,
            namespace: args[0] ? `${target.databaseName}.${String(args[0])}` : target.databaseName,
            affected: null,
            note: property === 'dropDatabase' ? 'the whole database would be dropped' : undefined
          });
          return { acknowledged: false, dryRun: true };
        };
      }

      // `db.collection` etc. keep their driver meaning...
      if (property in target) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'collection') {
          return (name: string) => wrapCollection(target.collection(name), guard);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
      // ...anything else is treated as a collection name, like the shell.
      return wrapCollection(target.collection(property), guard);
    }
  }) as Db & Record<string, unknown>;
}

/** A raw command can do anything, so the write ones go through the guard too. */
function runGuardedCommand(
  db: Db,
  command: Record<string, unknown>,
  guard: WriteGuard
): Promise<Document> | Document {
  const name = Object.keys(command ?? {})[0] ?? '';
  if (guard.mode === 'allow' || !WRITE_COMMANDS.has(name.toLowerCase())) {
    return db.command(command);
  }
  if (guard.mode === 'refuse') throw new Error(guard.refusal);
  guard.record({
    method: name,
    namespace: `${db.databaseName}.${String(command[name] ?? '')}`.replace(/\.$/, ''),
    affected: null,
    note: 'a command that writes'
  });
  return { ok: 1, dryRun: true };
}

function isCursor(value: unknown): value is AsyncIterable<unknown> & {
  toArray: () => Promise<unknown[]>;
  explain?: (verbosity: string) => Promise<unknown>;
} {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.toArray === 'function' &&
    typeof (candidate as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/** Adds `return` to the final statement of a script so it produces a result. */
function returnLastStatement(code: string): string | null {
  const lines = code.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || line === '}' || line.startsWith('//')) continue;
    if (/^(const|let|var|if|for|while|do|function|class|switch|try|catch|})/.test(line)) {
      return null;
    }
    const rewritten = [...lines];
    rewritten[index] = `return (${line.replace(/;+$/, '')});`;
    return rewritten.join('\n');
  }
  return null;
}

/**
 * Turns user input into an async function body. Single expressions are
 * returned implicitly; multi-statement scripts should use an explicit `return`,
 * and as a fallback we try returning their last statement.
 */
function compile(code: string, paramNames: string[]) {
  const trimmed = code.trim().replace(/;+\s*$/, '');
  if (!trimmed) throw new Error('Nothing to run — the editor is empty.');

  const candidates: string[] = [];
  if (/\breturn\b/.test(trimmed)) {
    candidates.push(trimmed);
  } else {
    candidates.push(`return (\n${trimmed}\n);`);
    const withReturnedTail = returnLastStatement(trimmed);
    if (withReturnedTail) candidates.push(withReturnedTail);
    candidates.push(trimmed);
  }

  let firstError: unknown;
  for (const body of candidates) {
    try {
      return new AsyncFunction(...paramNames, `"use strict";\n${body}`);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError instanceof Error
    ? new Error(`Syntax error: ${firstError.message}`)
    : new Error('The query could not be parsed.');
}

function describeOperation(code: string): { collection: string | null; operation: string | null } {
  const explicit = code.match(/db\s*\.\s*getCollection\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.\s*(\w+)/);
  if (explicit) return { collection: explicit[1], operation: explicit[2] };
  const direct = code.match(/db\s*\.\s*([A-Za-z_$][\w$.]*)\s*\.\s*(\w+)/);
  if (direct) return { collection: direct[1], operation: direct[2] };
  const dbLevel = code.match(/db\s*\.\s*(\w+)\s*\(/);
  return { collection: null, operation: dbLevel ? dbLevel[1] : null };
}

/** Converts BSON to relaxed EJSON, which is structured-clone safe. */
function serializeDocuments(documents: unknown[]): unknown[] {
  return documents.map((doc) =>
    doc && typeof doc === 'object'
      ? (EJSON.serialize(doc as never, { relaxed: true }) as unknown)
      : doc
  );
}

function collectColumns(documents: unknown[]): string[] {
  const seen = new Set<string>();
  for (const doc of documents) {
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      for (const key of Object.keys(doc as Record<string, unknown>)) seen.add(key);
    } else {
      seen.add('value');
    }
  }
  const columns = [...seen];
  // `_id` first, matching every Mongo GUI people already know.
  return columns.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
}

async function drainCursor(
  cursor: AsyncIterable<unknown>,
  limit: number
): Promise<{ documents: unknown[]; truncated: boolean }> {
  const documents: unknown[] = [];
  for await (const doc of cursor) {
    if (documents.length >= limit) return { documents, truncated: true };
    documents.push(doc);
  }
  return { documents, truncated: false };
}

export async function runQuery(request: QueryRequest): Promise<QueryResult> {
  const client = getClient(request.connectionId);
  if (!request.database) throw new Error('Select a database before running a query.');

  const preview: QueryWritePreview[] = [];
  const readOnly = connectionIsReadOnly(request.connectionId);
  const guard: WriteGuard = {
    mode: readOnly ? 'refuse' : request.dryRun ? 'preview' : 'allow',
    refusal:
      'This connection is marked read-only, so the query was stopped before it wrote anything. Turn read-only off in the connection\'s settings if you meant to write to it.',
    record: (entry) => preview.push(entry)
  };

  const rootDb = client.db(request.database);
  const db = wrapDb(rootDb, (name: string) => client.db(name), guard);
  const limit = Math.min(Math.max(request.limit ?? 200, 1), HARD_DOCUMENT_CAP);
  const skip = Math.max(request.skip ?? 0, 0);

  const scope: Record<string, unknown> = {
    db,
    ...buildHelpers(),
    // Shadow the Node globals a query has no business touching.
    ...SHADOWED_GLOBALS
  };

  const paramNames = Object.keys(scope);
  const fn = compile(request.code, paramNames);
  const started = Date.now();
  let raw = await fn(...paramNames.map((name) => scope[name]));

  // Paging is applied to the cursor the query returned, so it composes with any
  // skip the query itself asked for.
  if (skip > 0 && isCursor(raw) && typeof (raw as { skip?: unknown }).skip === 'function') {
    raw = (raw as unknown as { skip: (count: number) => unknown }).skip(skip);
  }

  const { collection, operation } = describeOperation(request.code);
  const base = {
    columns: [] as string[],
    totalReturned: 0,
    truncated: false,
    durationMs: 0,
    database: request.database,
    collection,
    operation,
    preview: request.dryRun ? preview : undefined
  };

  if (request.explain && isCursor(raw) && typeof raw.explain === 'function') {
    const explained = await raw.explain(request.explain);
    const documents = serializeDocuments([explained]);
    return {
      ...base,
      kind: 'documents',
      documents,
      columns: collectColumns(documents),
      totalReturned: 1,
      durationMs: Date.now() - started,
      explain: documents[0]
    };
  }

  if (isCursor(raw)) {
    const { documents, truncated } = await drainCursor(raw, limit);
    const serialized = serializeDocuments(documents);
    return {
      ...base,
      kind: 'documents',
      documents: serialized,
      columns: collectColumns(serialized),
      totalReturned: serialized.length,
      truncated,
      durationMs: Date.now() - started
    };
  }

  if (raw instanceof Promise) raw = await raw;
  const durationMs = Date.now() - started;

  if (Array.isArray(raw)) {
    const trimmed = raw.slice(skip, skip + limit);
    const serialized = serializeDocuments(trimmed);
    return {
      ...base,
      kind: 'documents',
      documents: serialized,
      columns: collectColumns(serialized),
      totalReturned: serialized.length,
      truncated: raw.length > skip + trimmed.length,
      durationMs
    };
  }

  if (raw === null || raw === undefined) {
    return { ...base, kind: 'empty', documents: [], durationMs };
  }

  if (typeof raw !== 'object') {
    return { ...base, kind: 'value', documents: [], value: raw, durationMs };
  }

  const record = raw as Record<string, unknown>;
  const isAck =
    'acknowledged' in record ||
    'insertedId' in record ||
    'insertedIds' in record ||
    'modifiedCount' in record ||
    'deletedCount' in record ||
    'upsertedCount' in record;

  const serialized = serializeDocuments([record]);
  return {
    ...base,
    kind: isAck ? 'acknowledgement' : 'documents',
    documents: isAck ? [] : serialized,
    value: isAck ? serialized[0] : undefined,
    columns: isAck ? [] : collectColumns(serialized),
    totalReturned: isAck ? 0 : 1,
    durationMs
  };
}
