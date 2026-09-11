import {
  Decimal128,
  Double,
  Int32,
  Long,
  type CreateIndexesOptions,
  type Db,
  type Document,
  type IndexSpecification
} from 'mongodb';
import type {
  CollectionStats,
  CollectionSummary,
  CreateIndexRequest,
  DatabaseStats,
  DatabaseSummary,
  DocumentRef,
  IndexInfo
} from '../../shared/types.js';
import { EJSON, evaluateExpression } from './bsonEval.js';
import { getClient, getDb } from './pool.js';

const SAMPLE_SIZE = 200;

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const converted = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(converted) ? converted : fallback;
  }
  return fallback;
}

export async function listDatabases(connectionId: string): Promise<DatabaseSummary[]> {
  const result = await getClient(connectionId).db('admin').admin().listDatabases();
  return result.databases
    .map((database) => ({
      name: database.name,
      sizeOnDisk: num(database.sizeOnDisk),
      empty: Boolean(database.empty)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listCollections(
  connectionId: string,
  database: string
): Promise<CollectionSummary[]> {
  const db = getDb(connectionId, database);
  const collections = await db.listCollections().toArray();
  const summaries = await Promise.all(
    collections.map(async (collection) => {
      const options = (collection as { options?: Record<string, unknown> }).options;
      const type =
        collection.type === 'view' ? 'view' : options?.timeseries ? 'timeseries' : 'collection';
      let documentCount: number | null = null;
      if (type === 'collection') {
        // estimatedDocumentCount reads collection metadata, so it stays cheap
        // even on very large collections.
        documentCount = await db
          .collection(collection.name)
          .estimatedDocumentCount()
          .catch(() => null);
      }
      return { name: collection.name, type, documentCount } as CollectionSummary;
    })
  );
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `collStats` was removed as a command target in some deployments (and is
 * deprecated since 6.2), so fall back to the `$collStats` aggregation stage.
 */
async function readCollStats(db: Db, collection: string): Promise<Document> {
  try {
    return await db.command({ collStats: collection });
  } catch {
    const [result] = await db
      .collection(collection)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    const storage = (result?.storageStats ?? {}) as Document;
    return { ...storage, ns: `${db.databaseName}.${collection}` };
  }
}

async function readIndexes(db: Db, collection: string): Promise<IndexInfo[]> {
  const specs = await db.collection(collection).indexes();
  const stats = await db
    .collection(collection)
    .aggregate([{ $indexStats: {} }])
    .toArray()
    .catch(() => [] as Document[]);
  const collStats = await readCollStats(db, collection).catch(() => ({}) as Document);
  const indexSizes = (collStats.indexSizes ?? {}) as Record<string, unknown>;

  return specs.map((spec) => {
    const usage = stats.find((entry) => entry.name === spec.name);
    return {
      name: String(spec.name),
      keys: (spec.key ?? {}) as Record<string, unknown>,
      unique: Boolean(spec.unique),
      sparse: Boolean(spec.sparse),
      ttlSeconds:
        typeof spec.expireAfterSeconds === 'number' ? spec.expireAfterSeconds : null,
      sizeBytes: spec.name && spec.name in indexSizes ? num(indexSizes[String(spec.name)]) : null,
      usageCount: usage ? num(usage.accesses?.ops) : null,
      since: usage?.accesses?.since ? new Date(usage.accesses.since).toISOString() : null
    };
  });
}

/** Samples documents to show which top-level fields actually exist. */
async function sampleFields(
  db: Db,
  collection: string
): Promise<CollectionStats['sampledFields']> {
  const docs = await db
    .collection(collection)
    .aggregate([{ $sample: { size: SAMPLE_SIZE } }], { allowDiskUse: false })
    .toArray()
    .catch(() => [] as Document[]);
  if (docs.length === 0) return [];

  const fields = new Map<string, { count: number; types: Set<string> }>();
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const entry = fields.get(key) ?? { count: 0, types: new Set<string>() };
      entry.count += 1;
      entry.types.add(bsonTypeOf(value));
      fields.set(key, entry);
    }
  }

  return [...fields.entries()]
    .map(([field, entry]) => ({
      field,
      types: [...entry.types].sort(),
      presencePercent: Math.round((entry.count / docs.length) * 1000) / 10
    }))
    .sort((a, b) => b.presencePercent - a.presencePercent || a.field.localeCompare(b.field));
}

function bsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') {
    const name = (value as object).constructor?.name ?? 'object';
    return name === 'Object' ? 'object' : name.toLowerCase();
  }
  return typeof value;
}

export async function collectionStats(
  connectionId: string,
  database: string,
  collection: string
): Promise<CollectionStats> {
  const db = getDb(connectionId, database);
  const [stats, indexes, sampledFields] = await Promise.all([
    readCollStats(db, collection),
    readIndexes(db, collection).catch(() => [] as IndexInfo[]),
    sampleFields(db, collection)
  ]);

  return {
    ns: String(stats.ns ?? `${database}.${collection}`),
    documentCount: num(stats.count),
    avgObjectSizeBytes: num(stats.avgObjSize),
    dataSizeBytes: num(stats.size),
    storageSizeBytes: num(stats.storageSize),
    totalIndexSizeBytes: num(stats.totalIndexSize),
    indexCount: num(stats.nindexes, indexes.length),
    capped: Boolean(stats.capped),
    shardKey: (stats.shardKey as Record<string, unknown>) ?? null,
    indexes,
    sampledFields
  };
}

export async function databaseStats(
  connectionId: string,
  database: string
): Promise<DatabaseStats> {
  const db = getDb(connectionId, database);
  const stats = await db.command({ dbStats: 1 });
  const collections = await db.listCollections().toArray();

  const perCollection = await Promise.all(
    collections
      .filter((entry) => entry.type !== 'view')
      .map(async (entry) => {
        const collStats = await readCollStats(db, entry.name).catch(() => ({}) as Document);
        return {
          name: entry.name,
          documentCount: num(collStats.count),
          dataSizeBytes: num(collStats.size),
          storageSizeBytes: num(collStats.storageSize),
          indexSizeBytes: num(collStats.totalIndexSize),
          indexCount: num(collStats.nindexes)
        };
      })
  );

  return {
    name: database,
    collectionCount: num(stats.collections, collections.length),
    viewCount: num(stats.views, collections.filter((entry) => entry.type === 'view').length),
    objectCount: num(stats.objects),
    avgObjectSizeBytes: num(stats.avgObjSize),
    dataSizeBytes: num(stats.dataSize),
    storageSizeBytes: num(stats.storageSize),
    indexCount: num(stats.indexes),
    indexSizeBytes: num(stats.indexSize),
    fsUsedSizeBytes: stats.fsUsedSize === undefined ? null : num(stats.fsUsedSize),
    fsTotalSizeBytes: stats.fsTotalSize === undefined ? null : num(stats.fsTotalSize),
    collections: perCollection.sort((a, b) => b.dataSizeBytes - a.dataSizeBytes)
  };
}

export async function indexesFor(
  connectionId: string,
  database: string,
  collection: string
): Promise<IndexInfo[]> {
  return readIndexes(getDb(connectionId, database), collection);
}

// Mongo rejects these server-side too, but the driver errors are cryptic — check up front so the
// dialog can point at the offending character.
const DATABASE_NAME_FORBIDDEN = /[/\\. "$*<>:|?\0]/;

function assertDatabaseName(database: string): void {
  if (!database) throw new Error('Enter a database name.');
  const forbidden = database.match(DATABASE_NAME_FORBIDDEN);
  if (forbidden) {
    throw new Error(
      `A database name cannot contain ${JSON.stringify(forbidden[0])}. Avoid / \\ . " $ * < > : | ? and spaces.`
    );
  }
  if (Buffer.byteLength(database, 'utf8') > 63) {
    throw new Error('A database name must be 63 bytes or fewer.');
  }
}

function assertCollectionName(collection: string): void {
  if (!collection) throw new Error('Enter a collection name.');
  if (collection.includes('$')) throw new Error('A collection name cannot contain "$".');
  if (collection.includes('\0')) throw new Error('A collection name cannot contain a null byte.');
  if (collection.startsWith('system.')) {
    throw new Error('Collection names starting with "system." are reserved for MongoDB.');
  }
}

export async function createCollection(
  connectionId: string,
  database: string,
  collection: string
): Promise<void> {
  assertDatabaseName(database);
  assertCollectionName(collection);
  await getDb(connectionId, database).createCollection(collection);
}

/**
 * MongoDB has no "create database" command: a database starts existing once it holds something.
 * Creating the first collection is what materialises it, so the two are one operation here.
 */
export async function createDatabase(
  connectionId: string,
  database: string,
  collection: string
): Promise<void> {
  assertDatabaseName(database);
  assertCollectionName(collection);
  const existing = await listDatabases(connectionId);
  if (existing.some((entry) => entry.name === database)) {
    throw new Error(`The database "${database}" already exists.`);
  }
  await getDb(connectionId, database).createCollection(collection);
}

export async function dropCollection(
  connectionId: string,
  database: string,
  collection: string
): Promise<void> {
  await getDb(connectionId, database).collection(collection).drop();
}

export async function dropDatabase(connectionId: string, database: string): Promise<void> {
  await getDb(connectionId, database).dropDatabase();
}

export async function createIndex(request: CreateIndexRequest): Promise<{ name: string }> {
  const keys = evaluateExpression<IndexSpecification>(request.keys, 'index keys');
  if (!keys || Object.keys(keys).length === 0) {
    throw new Error('Specify at least one index key, e.g. { createdAt: -1 }.');
  }

  const options: CreateIndexesOptions = {};
  if (request.name?.trim()) options.name = request.name.trim();
  if (request.unique) options.unique = true;
  if (request.sparse) options.sparse = true;
  if (typeof request.expireAfterSeconds === 'number') {
    options.expireAfterSeconds = request.expireAfterSeconds;
  }
  const partial = evaluateExpression<Document>(request.partialFilter, 'partial filter expression');
  if (partial) options.partialFilterExpression = partial;
  const collation = evaluateExpression<Document>(request.collation, 'collation');
  if (collation) options.collation = collation as CreateIndexesOptions['collation'];

  const name = await getDb(request.connectionId, request.database)
    .collection(request.collection)
    .createIndex(keys, options);
  return { name };
}

export async function dropIndex(
  connectionId: string,
  database: string,
  collection: string,
  indexName: string
): Promise<void> {
  if (indexName === '_id_') throw new Error('The _id index cannot be dropped.');
  await getDb(connectionId, database).collection(collection).dropIndex(indexName);
}

/**
 * Documents are read back in canonical EJSON so an edit round-trip cannot
 * silently change an int64 into a double.
 */
export async function getDocument(ref: DocumentRef): Promise<string> {
  const filter = { _id: parseId(ref.idJson) };
  const document = await getDb(ref.connectionId, ref.database)
    .collection(ref.collection)
    .findOne(filter as Document);
  if (!document) throw new Error('That document no longer exists.');
  return EJSON.stringify(document, undefined, 2, { relaxed: false });
}

export async function replaceDocument(ref: DocumentRef, documentJson: string): Promise<void> {
  const replacement = parseDocument(documentJson);
  const id = parseId(ref.idJson);
  // Mongo rejects a replacement that changes _id, so compare before writing.
  if ('_id' in replacement && !idsEqual(replacement._id, id)) {
    throw new Error('The _id of an existing document cannot be changed.');
  }
  delete (replacement as Record<string, unknown>)._id;
  const result = await getDb(ref.connectionId, ref.database)
    .collection(ref.collection)
    .replaceOne({ _id: id } as Document, replacement);
  if (result.matchedCount === 0) throw new Error('That document no longer exists.');
}

export async function insertDocument(
  connectionId: string,
  database: string,
  collection: string,
  documentJson: string
): Promise<{ insertedId: unknown }> {
  const document = parseDocument(documentJson);
  const result = await getDb(connectionId, database).collection(collection).insertOne(document);
  return { insertedId: EJSON.serialize(result.insertedId, { relaxed: true }) };
}

export async function deleteDocument(ref: DocumentRef): Promise<void> {
  const result = await getDb(ref.connectionId, ref.database)
    .collection(ref.collection)
    .deleteOne({ _id: parseId(ref.idJson) } as Document);
  if (result.deletedCount === 0) throw new Error('That document no longer exists.');
}

/**
 * Writes a single field, which is what in-place editing in the result table
 * needs. The value arrives as canonical EJSON so BSON wrappers survive the trip,
 * and a plain number is re-wrapped in whatever numeric type the field already
 * holds — otherwise editing an int32 cell would silently widen it to a double.
 * Returns the stored value as relaxed EJSON so the table can repaint one cell
 * instead of re-running the query.
 */
export async function setDocumentField(
  ref: DocumentRef,
  field: string,
  valueJson: string
): Promise<{ value: unknown }> {
  assertEditableField(field);
  const id = parseId(ref.idJson);
  const collection = getDb(ref.connectionId, ref.database).collection(ref.collection);
  // `$type` is the only reliable answer to "what is stored here?" — the driver
  // hands back int32 and double as the same JS number.
  const [current] = await collection
    .aggregate([{ $match: { _id: id } }, { $project: { type: { $type: `$${field}` } } }])
    .toArray();
  if (!current) throw new Error('That document no longer exists.');

  const value = keepNumericType(parseValue(valueJson), String(current.type));
  const result = await collection.updateOne({ _id: id } as Document, { $set: { [field]: value } });
  if (result.matchedCount === 0) throw new Error('That document no longer exists.');
  return { value: serializeValue(value) };
}

export async function unsetDocumentField(ref: DocumentRef, field: string): Promise<void> {
  assertEditableField(field);
  const result = await getDb(ref.connectionId, ref.database)
    .collection(ref.collection)
    .updateOne({ _id: parseId(ref.idJson) } as Document, { $unset: { [field]: '' } });
  if (result.matchedCount === 0) throw new Error('That document no longer exists.');
}

/** Inserts a copy of the document; the copy gets a freshly generated `_id`. */
export async function duplicateDocument(ref: DocumentRef): Promise<{ insertedId: unknown }> {
  const collection = getDb(ref.connectionId, ref.database).collection(ref.collection);
  const document = await collection.findOne({ _id: parseId(ref.idJson) } as Document);
  if (!document) throw new Error('That document no longer exists.');
  delete (document as Record<string, unknown>)._id;
  const result = await collection.insertOne(document);
  return { insertedId: serializeValue(result.insertedId) };
}

function assertEditableField(field: string): void {
  if (!field) throw new Error('No field was given.');
  if (field === '_id') throw new Error('The _id of an existing document cannot be changed.');
  if (field.startsWith('$') || field.includes('.') || field.includes('\0')) {
    throw new Error(
      `The field "${field}" cannot be written on its own — edit the whole document as JSON instead.`
    );
  }
}

function parseDocument(json: string): Document {
  try {
    const parsed = EJSON.parse(json, { relaxed: false });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('a document must be a JSON object');
    }
    return parsed as Document;
  } catch (error) {
    throw new Error(`Invalid document: ${(error as Error).message}`);
  }
}

function parseId(idJson: string): unknown {
  try {
    return EJSON.parse(idJson, { relaxed: false });
  } catch (error) {
    throw new Error(`Invalid document id: ${(error as Error).message}`);
  }
}

function idsEqual(left: unknown, right: unknown): boolean {
  return EJSON.stringify(left, { relaxed: false }) === EJSON.stringify(right, { relaxed: false });
}

/** Parses one canonical-EJSON value. Wrapping it keeps bare scalars legal. */
function parseValue(valueJson: string): unknown {
  try {
    const { v } = EJSON.parse(`{"v":${valueJson}}`, { relaxed: false }) as { v: unknown };
    return v;
  } catch (error) {
    throw new Error(`Invalid value: ${(error as Error).message}`);
  }
}

function serializeValue(value: unknown): unknown {
  const { v } = EJSON.serialize({ v: value }, { relaxed: true }) as { v: unknown };
  return v;
}

/** The decimal text of a number in any BSON numeric type, else null. */
function numericText(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (value instanceof Int32 || value instanceof Double) return String(value.value);
  if (value instanceof Long || value instanceof Decimal128) return value.toString();
  return null;
}

/**
 * Re-wraps a numeric edit in the type the field already stored, named by the
 * server's `$type`. Anything else — a non-numeric value, a fraction typed into
 * an integer field, a field that did not exist — is left as parsed.
 */
function keepNumericType(next: unknown, bsonType: string): unknown {
  const text = numericText(next);
  if (text === null) return next;
  const integral = /^[+-]?\d+$/.test(text);

  if (bsonType === 'decimal') return Decimal128.fromString(text);
  if (bsonType === 'double') return new Double(Number(text));
  if (bsonType === 'long' && integral) return Long.fromString(text);
  if (bsonType === 'int' && integral) {
    const value = Number(text);
    const fitsInt32 = value >= -2_147_483_648 && value <= 2_147_483_647;
    return fitsInt32 ? new Int32(value) : Long.fromString(text);
  }
  return next;
}
