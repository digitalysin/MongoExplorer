import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AnyBulkWriteOperation, Document, Sort } from 'mongodb';
import type {
  ExportFormat,
  ExportManyRequest,
  ExportRequest,
  ImportFormat,
  ImportRequest,
  TransferPart,
  TransferProgress,
  TransferResult
} from '../../shared/types.js';
import { EJSON, evaluateExpression } from './bsonEval.js';
import {
  CsvRowParser,
  coerceCsvValue,
  encodeCsvRow,
  flattenDocument,
  setDeep
} from './csv.js';
import { getDb } from './pool.js';

const PROGRESS_INTERVAL_MS = 150;
const CSV_HEADER_SAMPLE = 500;
const MAX_REPORTED_ERRORS = 50;

export type ProgressReporter = (progress: TransferProgress) => void;

const cancelled = new Set<string>();

export function cancelJob(jobId: string): void {
  cancelled.add(jobId);
}

function throwIfCancelled(jobId: string): void {
  if (cancelled.has(jobId)) {
    const error = new Error('Cancelled by user.');
    error.name = 'CancelledError';
    throw error;
  }
}

/** A request that arrived too late must not cancel the next job. */
function forgetCancellation(jobId: string): void {
  cancelled.delete(jobId);
}

type ProgressUpdate = Omit<TransferProgress, 'jobId' | 'kind' | 'phase' | 'startedAt' | 'filePath'>;

function makeThrottledReporter(
  jobId: string,
  kind: TransferProgress['kind'],
  report: ProgressReporter,
  filePath: string,
  startedAt: string
) {
  let lastSent = 0;
  return (update: ProgressUpdate, force = false) => {
    const now = Date.now();
    if (!force && now - lastSent < PROGRESS_INTERVAL_MS) return;
    lastSent = now;
    report({ jobId, kind, phase: 'running', startedAt, filePath, ...update });
  };
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function writeChunk(stream: fs.WriteStream, text: string): Promise<void> {
  if (!stream.write(text)) {
    await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}

async function closeStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.once('error', reject);
  });
}

/** Extensions the built-in formats write, for naming one file per collection. */
const EXTENSIONS: Record<ExportFormat, string> = {
  'json-array': 'json',
  ndjson: 'ndjson',
  csv: 'csv'
};

/** A collection name is not a file name — it may hold anything but `$` and NUL. */
function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'collection';
}

/**
 * How many documents the export will write, or null when the collection is too
 * large to count inside the budget — that leaves the bar open-ended rather than
 * holding the export up.
 */
async function countForExport(request: ExportRequest, filter: Document): Promise<number | null> {
  const matched = await getDb(request.connectionId, request.database)
    .collection(request.collection)
    .countDocuments(filter, { maxTimeMS: 15_000 })
    .catch(() => null);
  if (matched === null) return null;
  // Skip and limit decide how many of the matches actually get written.
  return Math.max(0, Math.min(matched - (request.skip ?? 0), request.limit ?? matched));
}

/**
 * Writes one collection to one file. Progress is handed to the caller as plain
 * numbers, so a single export and one collection of a batch report the same way.
 */
async function exportToFile(
  request: ExportRequest,
  jobId: string,
  onProgress: (processed: number, bytes: number) => void
): Promise<{ processed: number; bytes: number }> {
  const collection = getDb(request.connectionId, request.database).collection(request.collection);
  const filter = evaluateExpression<Document>(request.filter, 'filter') ?? {};
  const projection = evaluateExpression<Document>(request.projection, 'projection');
  const sort = evaluateExpression<Document>(request.sort, 'sort');

  let cursor = collection.find(filter, { projection: projection ?? undefined });
  if (sort) cursor = cursor.sort(sort as Sort);
  if (request.skip) cursor = cursor.skip(request.skip);
  if (request.limit) cursor = cursor.limit(request.limit);

  ensureParentDirectory(request.filePath);
  const stream = fs.createWriteStream(request.filePath, { encoding: 'utf8' });
  const relaxed = request.jsonMode !== 'canonical';
  let processed = 0;
  try {
    if (request.format === 'csv') {
      processed = await writeCsv(cursor, stream, request, ',', jobId, onProgress);
    } else {
      const isArray = request.format === 'json-array';
      if (isArray) await writeChunk(stream, '[\n');
      for await (const doc of cursor) {
        throwIfCancelled(jobId);
        const text = EJSON.stringify(doc, undefined, request.prettyPrint ? 2 : undefined, {
          relaxed
        });
        if (isArray) {
          await writeChunk(stream, processed === 0 ? text : `,\n${text}`);
        } else {
          await writeChunk(stream, `${text}\n`);
        }
        processed += 1;
        onProgress(processed, stream.bytesWritten);
      }
      if (isArray) await writeChunk(stream, '\n]\n');
    }
    await closeStream(stream);
    return { processed, bytes: stream.bytesWritten };
  } catch (error) {
    stream.destroy();
    await cursor.close().catch(() => undefined);
    throw error;
  }
}

export async function exportCollection(
  request: ExportRequest,
  report: ProgressReporter
): Promise<TransferResult> {
  const jobId = randomUUID();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  report({
    jobId,
    kind: 'export',
    phase: 'starting',
    processed: 0,
    total: null,
    startedAt,
    filePath: request.filePath,
    message: `Exporting ${request.database}.${request.collection}`
  });

  const filter = evaluateExpression<Document>(request.filter, 'filter') ?? {};
  const total = await countForExport(request, filter);
  const tick = makeThrottledReporter(jobId, 'export', report, request.filePath, startedAt);
  // Publish the total before the first document, so the bar starts out honest.
  tick({ processed: 0, total, bytes: 0 }, true);

  let processed = 0;
  try {
    const outcome = await exportToFile(request, jobId, (done, bytes) => {
      processed = done;
      tick({ processed, total, bytes });
    });
    processed = outcome.processed;
    const result: TransferResult = {
      jobId,
      ok: true,
      processed,
      failed: 0,
      filePath: request.filePath,
      durationMs: Date.now() - started,
      errors: []
    };
    report({
      jobId,
      kind: 'export',
      phase: 'done',
      processed,
      total: processed,
      startedAt,
      filePath: request.filePath,
      bytes: fs.statSync(request.filePath).size,
      message: `Exported ${processed.toLocaleString()} documents`
    });
    return result;
  } catch (error) {
    const isCancel = error instanceof Error && error.name === 'CancelledError';
    report({
      jobId,
      kind: 'export',
      phase: isCancel ? 'cancelled' : 'error',
      processed,
      total,
      startedAt,
      filePath: request.filePath,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    forgetCancellation(jobId);
  }
}

/** The collections a whole-database export covers: no views, nothing internal. */
export async function exportableCollections(
  connectionId: string,
  database: string
): Promise<string[]> {
  const entries = await getDb(connectionId, database)
    .listCollections({}, { nameOnly: true })
    .toArray();
  return entries
    .filter((entry) => entry.type !== 'view' && !entry.name.startsWith('system.'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Exports several collections, or a whole database, as one job: a directory
 * named after the database holding one file per collection. The bar counts
 * every collection up front so it spans the job rather than restarting, and a
 * collection that fails is recorded and the rest still run — half a database is
 * more use than none, as long as the failure is reported.
 */
export async function exportCollections(
  request: ExportManyRequest,
  report: ProgressReporter
): Promise<TransferResult> {
  const jobId = randomUUID();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const names =
    request.collections.length > 0
      ? request.collections
      : await exportableCollections(request.connectionId, request.database);
  const directory = path.join(request.directory, safeFileName(request.database));

  if (names.length === 0) {
    throw new Error(`${request.database} holds no collections to export.`);
  }

  report({
    jobId,
    kind: 'export',
    phase: 'starting',
    processed: 0,
    total: null,
    startedAt,
    filePath: directory,
    message: `Exporting ${names.length} collections from ${request.database}`
  });

  const single = (collection: string): ExportRequest => ({
    connectionId: request.connectionId,
    database: request.database,
    collection,
    format: request.format,
    filePath: path.join(directory, `${safeFileName(collection)}.${EXTENSIONS[request.format]}`),
    filter: request.filter,
    limit: request.limit,
    jsonMode: request.jsonMode,
    prettyPrint: request.prettyPrint
  });

  const filter = evaluateExpression<Document>(request.filter, 'filter') ?? {};
  const counts = await Promise.all(names.map((name) => countForExport(single(name), filter)));
  const total = counts.some((count) => count === null)
    ? null
    : counts.reduce((sum: number, count) => sum + (count ?? 0), 0);

  const tick = makeThrottledReporter(jobId, 'export', report, directory, startedAt);
  tick({ processed: 0, total, bytes: 0 }, true);

  const parts: TransferPart[] = [];
  const errors: string[] = [];
  let processed = 0;
  let bytes = 0;
  try {
    for (const [index, name] of names.entries()) {
      throwIfCancelled(jobId);
      const target = single(name);
      const message = `${name} — ${index + 1} of ${names.length}`;
      const before = { processed, bytes };
      tick({ processed, total, bytes, message }, true);
      try {
        const outcome = await exportToFile(target, jobId, (donePart, bytesPart) => {
          tick({
            processed: before.processed + donePart,
            total,
            bytes: before.bytes + bytesPart,
            message
          });
        });
        processed = before.processed + outcome.processed;
        bytes = before.bytes + outcome.bytes;
        parts.push({ collection: name, processed: outcome.processed, filePath: target.filePath });
      } catch (error) {
        if (error instanceof Error && error.name === 'CancelledError') throw error;
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`${name}: ${detail}`);
        parts.push({
          collection: name,
          processed: 0,
          filePath: target.filePath,
          error: detail
        });
      }
    }

    report({
      jobId,
      kind: 'export',
      phase: 'done',
      processed,
      total: processed,
      bytes,
      startedAt,
      filePath: directory,
      message: `Exported ${processed.toLocaleString()} documents from ${
        parts.length - errors.length
      } of ${names.length} collections`,
      errors: errors.length > 0 ? errors : undefined
    });
    return {
      jobId,
      ok: errors.length === 0,
      processed,
      failed: errors.length,
      filePath: directory,
      durationMs: Date.now() - started,
      errors,
      parts
    };
  } catch (error) {
    const isCancel = error instanceof Error && error.name === 'CancelledError';
    report({
      jobId,
      kind: 'export',
      phase: isCancel ? 'cancelled' : 'error',
      processed,
      total,
      bytes,
      startedAt,
      filePath: directory,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    forgetCancellation(jobId);
  }
}

async function writeCsv(
  cursor: AsyncIterable<Document>,
  stream: fs.WriteStream,
  request: ExportRequest,
  delimiter: string,
  jobId: string,
  onProgress: (processed: number, bytes: number) => void
): Promise<number> {
  const buffered: Array<Record<string, unknown>> = [];
  let columns = request.fields?.filter((field) => field.trim().length > 0) ?? [];
  let processed = 0;
  let headerWritten = false;

  const writeHeader = async () => {
    await writeChunk(stream, `${encodeCsvRow(columns, delimiter)}\n`);
    headerWritten = true;
  };
  const writeRow = async (flat: Record<string, unknown>) => {
    await writeChunk(
      stream,
      `${encodeCsvRow(
        columns.map((column) => normalizeCsvCell(flat[column])),
        delimiter
      )}\n`
    );
  };

  if (columns.length > 0) await writeHeader();

  for await (const doc of cursor) {
    throwIfCancelled(jobId);
    const flat = flattenDocument(EJSON.serialize(doc, { relaxed: true }));
    if (!headerWritten) {
      // Derive the column set from a sample so nested/optional fields are covered.
      buffered.push(flat);
      if (buffered.length >= CSV_HEADER_SAMPLE) {
        columns = deriveColumns(buffered);
        await writeHeader();
        for (const row of buffered) await writeRow(row);
        processed += buffered.length;
        buffered.length = 0;
        onProgress(processed, stream.bytesWritten);
      }
      continue;
    }
    await writeRow(flat);
    processed += 1;
    onProgress(processed, stream.bytesWritten);
  }

  if (!headerWritten) {
    columns = deriveColumns(buffered);
    await writeHeader();
    for (const row of buffered) await writeRow(row);
    processed += buffered.length;
  }
  return processed;
}

function deriveColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  const columns = [...seen];
  const idIndex = columns.indexOf('_id');
  if (idIndex > 0) columns.splice(0, 0, ...columns.splice(idIndex, 1));
  return columns.length > 0 ? columns : ['_id'];
}

function normalizeCsvCell(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$oid === 'string') return record.$oid;
    if (typeof record.$date === 'string') return record.$date;
    if (record.$numberLong !== undefined) return record.$numberLong;
    if (record.$numberDecimal !== undefined) return record.$numberDecimal;
  }
  return value;
}

function detectFormat(filePath: string, format: ImportFormat): Exclude<ImportFormat, 'auto'> {
  if (format !== 'auto') return format;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv' || extension === '.tsv') return 'csv';
  if (extension === '.ndjson' || extension === '.jsonl') return 'ndjson';
  if (extension === '.json') {
    // A file starting with '[' is an array; otherwise assume one doc per line.
    const handle = fs.openSync(filePath, 'r');
    try {
      const probe = Buffer.alloc(64);
      const bytes = fs.readSync(handle, probe, 0, 64, 0);
      const head = probe.subarray(0, bytes).toString('utf8').trimStart();
      return head.startsWith('[') ? 'json-array' : 'ndjson';
    } finally {
      fs.closeSync(handle);
    }
  }
  return 'ndjson';
}

/** Splits a streaming JSON array into its top-level values without buffering the file. */
class JsonArraySplitter {
  private buffer = '';
  private position = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private valueStart = -1;
  private arrayOpened = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const values: string[] = [];

    while (this.position < this.buffer.length) {
      const char = this.buffer[this.position];

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
      } else if (char === '"') {
        if (this.depth === 0 && this.valueStart < 0) this.valueStart = this.position;
        this.inString = true;
      } else if (char === '[' && this.depth === 0 && this.valueStart < 0 && !this.arrayOpened) {
        this.arrayOpened = true;
      } else if (char === '{' || char === '[') {
        if (this.depth === 0) this.valueStart = this.position;
        this.depth += 1;
      } else if (char === '}' || char === ']') {
        if (this.depth > 0) {
          this.depth -= 1;
          if (this.depth === 0 && this.valueStart >= 0) {
            values.push(this.buffer.slice(this.valueStart, this.position + 1));
            this.valueStart = -1;
          }
        }
      }

      this.position += 1;
    }

    if (this.valueStart < 0 && this.position > 1_000_000) {
      this.buffer = '';
      this.position = 0;
    } else if (this.valueStart > 0) {
      this.buffer = this.buffer.slice(this.valueStart);
      this.position -= this.valueStart;
      this.valueStart = 0;
    }
    return values;
  }
}

export async function importCollection(
  request: ImportRequest,
  report: ProgressReporter
): Promise<TransferResult> {
  const jobId = randomUUID();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const db = getDb(request.connectionId, request.database);
  const collection = db.collection(request.collection);
  const format = detectFormat(request.filePath, request.format);
  const batchSize = Math.min(Math.max(request.batchSize ?? 1000, 1), 10_000);
  const errors: string[] = [];

  const fileSize = fs.statSync(request.filePath).size;
  report({
    jobId,
    kind: 'import',
    phase: 'starting',
    processed: 0,
    total: null,
    totalBytes: fileSize,
    startedAt,
    filePath: request.filePath,
    message: `Importing into ${request.database}.${request.collection} (${format})`
  });

  if (request.dropBeforeImport) {
    await collection.drop().catch(() => undefined);
  }

  const tick = makeThrottledReporter(jobId, 'import', report, request.filePath, startedAt);
  tick({ processed: 0, total: null, bytes: 0, totalBytes: fileSize }, true);
  let processed = 0;
  let failed = 0;
  let batch: Document[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const documents = batch;
    batch = [];
    try {
      if (request.mode === 'insert') {
        await collection.insertMany(documents, { ordered: Boolean(request.stopOnError) });
      } else {
        await collection.bulkWrite(buildUpsertOps(documents, request), { ordered: false });
      }
      processed += documents.length;
    } catch (error) {
      const info = error as { writeErrors?: unknown[]; result?: { nInserted?: number } };
      const writeErrors = Array.isArray(info.writeErrors) ? info.writeErrors : [];
      const failedCount = writeErrors.length || documents.length;
      failed += failedCount;
      processed += documents.length - failedCount;
      const message = error instanceof Error ? error.message : String(error);
      if (errors.length < MAX_REPORTED_ERRORS) errors.push(message);
      if (request.stopOnError) throw error;
    }
  };

  const stream = fs.createReadStream(request.filePath, { encoding: 'utf8' });
  const splitter = new JsonArraySplitter();
  const csvParser = new CsvRowParser(request.csvDelimiter || ',');
  let csvHeader: string[] | null = request.csvHasHeader === false ? [] : null;
  let ndjsonRemainder = '';
  let bytesRead = 0;

  const handleDocumentText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const parsed = EJSON.parse(trimmed, { relaxed: true }) as Document;
      batch.push(parsed);
    } catch (error) {
      failed += 1;
      if (errors.length < MAX_REPORTED_ERRORS) {
        errors.push(`Could not parse a record: ${(error as Error).message}`);
      }
      if (request.stopOnError) throw error;
      return;
    }
    if (batch.length >= batchSize) await flush();
  };

  const handleCsvRow = async (row: string[]) => {
    if (csvHeader === null) {
      csvHeader = row.map((cell) => cell.trim());
      return;
    }
    const header =
      csvHeader.length > 0 ? csvHeader : row.map((_, index) => `field${index + 1}`);
    const doc: Record<string, unknown> = {};
    row.forEach((cell, index) => {
      const key = header[index] ?? `field${index + 1}`;
      setDeep(doc, key, coerceCsvValue(cell, request.csvInferTypes !== false));
    });
    batch.push(doc as Document);
    if (batch.length >= batchSize) await flush();
  };

  try {
    for await (const chunk of stream) {
      throwIfCancelled(jobId);
      const text = chunk as string;
      bytesRead += Buffer.byteLength(text, 'utf8');

      if (format === 'json-array') {
        for (const value of splitter.push(text)) await handleDocumentText(value);
      } else if (format === 'ndjson') {
        const combined = ndjsonRemainder + text;
        const lines = combined.split(/\r?\n/);
        ndjsonRemainder = lines.pop() ?? '';
        for (const line of lines) await handleDocumentText(line);
      } else {
        for (const row of csvParser.push(text)) await handleCsvRow(row);
      }
      // Documents flushed is not a share of anything until the file is read,
      // so the bytes consumed are what the progress bar tracks.
      tick({ processed, total: null, bytes: bytesRead, totalBytes: fileSize });
    }

    if (format === 'ndjson' && ndjsonRemainder.trim()) await handleDocumentText(ndjsonRemainder);
    if (format === 'csv') for (const row of csvParser.flush()) await handleCsvRow(row);
    await flush();

    report({
      jobId,
      kind: 'import',
      phase: 'done',
      processed,
      total: processed + failed,
      bytes: fileSize,
      totalBytes: fileSize,
      startedAt,
      filePath: request.filePath,
      errors,
      message: `Imported ${processed.toLocaleString()} documents${
        failed > 0 ? `, ${failed.toLocaleString()} failed` : ''
      }`
    });
    return {
      jobId,
      ok: failed === 0,
      processed,
      failed,
      filePath: request.filePath,
      durationMs: Date.now() - started,
      errors
    };
  } catch (error) {
    stream.destroy();
    const isCancel = error instanceof Error && error.name === 'CancelledError';
    report({
      jobId,
      kind: 'import',
      phase: isCancel ? 'cancelled' : 'error',
      processed,
      total: null,
      bytes: bytesRead,
      totalBytes: fileSize,
      startedAt,
      filePath: request.filePath,
      errors,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    forgetCancellation(jobId);
  }
}

function buildUpsertOps(
  documents: Document[],
  request: ImportRequest
): AnyBulkWriteOperation<Document>[] {
  const keys =
    request.upsertFields && request.upsertFields.length > 0 ? request.upsertFields : ['_id'];
  return documents.map((doc) => {
    const filter: Document = {};
    for (const key of keys) filter[key] = getDeep(doc, key);
    if (request.mode === 'replace') {
      return { replaceOne: { filter, replacement: doc, upsert: true } };
    }
    const update = { ...doc };
    delete (update as Record<string, unknown>)._id;
    return { updateOne: { filter, update: { $set: update }, upsert: true } };
  });
}

function getDeep(doc: Document, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      doc
    );
}
