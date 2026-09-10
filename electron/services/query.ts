import type { Collection, Db } from 'mongodb';
import type { QueryRequest, QueryResult } from '../../shared/types.js';
import { EJSON, SHADOWED_GLOBALS, buildHelpers } from './bsonEval.js';
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
 * Wraps a driver Collection so mongosh-style method names resolve, while
 * everything else falls through to the real driver API (including cursors,
 * which keeps `.sort().skip().limit()` chaining intact).
 */
function wrapCollection(collection: Collection): Collection {
  return new Proxy(collection, {
    get(target, property, receiver) {
      const key = typeof property === 'string' ? property : '';
      const resolved =
        key in target ? key : (SHELL_ALIASES[key] as string | undefined) ?? key;
      const value = Reflect.get(target, resolved, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Collection;
}

function wrapDb(db: Db, siblingFactory: (name: string) => Db): Db & Record<string, unknown> {
  const extras: Record<string, unknown> = {
    getCollection: (name: string) => wrapCollection(db.collection(name)),
    getSiblingDB: (name: string) => wrapDb(siblingFactory(name), siblingFactory),
    getName: () => db.databaseName,
    getCollectionNames: async () =>
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
    runCommand: (command: Record<string, unknown>) => db.command(command),
    stats: () => db.command({ dbStats: 1 })
  };

  return new Proxy(db, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver);
      if (property in extras) return extras[property];
      // `db.collection` / `db.command` etc. keep their driver meaning...
      if (property in target) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      // ...anything else is treated as a collection name, like the shell.
      return wrapCollection(target.collection(property));
    }
  }) as Db & Record<string, unknown>;
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

  const rootDb = client.db(request.database);
  const db = wrapDb(rootDb, (name: string) => client.db(name));
  const limit = Math.min(Math.max(request.limit ?? 200, 1), HARD_DOCUMENT_CAP);

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

  const { collection, operation } = describeOperation(request.code);
  const base = {
    columns: [] as string[],
    totalReturned: 0,
    truncated: false,
    durationMs: 0,
    database: request.database,
    collection,
    operation
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
    const trimmed = raw.slice(0, limit);
    const serialized = serializeDocuments(trimmed);
    return {
      ...base,
      kind: 'documents',
      documents: serialized,
      columns: collectColumns(serialized),
      totalReturned: serialized.length,
      truncated: raw.length > trimmed.length,
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
