import type { Db, Document } from 'mongodb';
import type {
  CollectionStats,
  CollectionSummary,
  DatabaseStats,
  DatabaseSummary,
  IndexInfo
} from '../../shared/types.js';
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

export async function createCollection(
  connectionId: string,
  database: string,
  collection: string
): Promise<void> {
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
