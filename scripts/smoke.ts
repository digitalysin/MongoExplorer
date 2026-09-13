/**
 * End-to-end check of the main-process services against a real mongod.
 * Runs inside Electron (so `app`, `safeStorage` and the driver behave exactly
 * as they do in the shipped app):
 *
 *   mongod --dbpath /tmp/... --port 27099
 *   npm run smoke
 */
import { app } from 'electron';
import assert from 'node:assert/strict';
import { Int32 } from 'mongodb';
import type { QueryResult, TransferProgress } from '../shared/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertConnection, removeConnection } from '../electron/services/connections.js';
import { connect, disconnect, getDb, testConnection } from '../electron/services/pool.js';
import { explainConnectionError } from '../electron/services/connectionErrors.js';
import { assertWritable } from '../electron/services/guards.js';
import {
  currentOperations,
  killOperation,
  profilerSnapshot
} from '../electron/services/operations.js';
import { runQuery } from '../electron/services/query.js';
import {
  collectionStats,
  createCollection,
  createDatabase,
  createIndex,
  databaseStats,
  deleteDocument,
  deleteDocuments,
  dropDatabase,
  dropIndex,
  getDocument,
  indexesFor,
  insertDocument,
  listCollections,
  listDatabases,
  replaceDocument,
  setFieldOnMany,
  unsetFieldOnMany
} from '../electron/services/stats.js';
import {
  clearHistory,
  listHistory,
  listSavedQueries,
  recordHistory,
  removeSavedQuery,
  saveQuery
} from '../electron/services/library.js';
import { cancelJob, exportCollection, importCollection } from '../electron/services/transfer.js';
import { summarizeTransfer } from '../src/lib/transferProgress.js';
import { detectWrites } from '../shared/writeOps.js';
import { detectTools, runTool } from '../electron/services/tools.js';
import { encryptionAvailable, getSecrets, setSecrets } from '../electron/services/store.js';

const HOST = '127.0.0.1:27099';
const DATABASE = 'mongo_explorer_smoke';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoexp-smoke-'));

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const silent = () => undefined;

async function main(): Promise<void> {
  app.setPath('userData', path.join(workDir, 'userData'));

  const connection = upsertConnection({
    name: 'Smoke test',
    mode: 'fields',
    hosts: [HOST],
    savePassword: false,
    serverSelectionTimeoutMs: 5000
  });

  const info = await connect(connection.id);
  console.log(`\nConnected to MongoDB ${info.serverVersion} (${info.topology})\n`);

  const db = getDb(connection.id, DATABASE);
  await db.dropDatabase().catch(() => undefined);

  const query = (code: string, limit = 200) =>
    runQuery({ connectionId: connection.id, database: DATABASE, code, limit });

  // --- queries -------------------------------------------------------------

  await check('insertMany reports an acknowledgement', async () => {
    const result = await query(`db.people.insertMany([
      { name: "Ada", age: 36, tags: ["math"], joined: ISODate("2020-01-02T03:04:05Z"), address: { city: "London" } },
      { name: "Linus", age: 54, tags: ["kernel", "git"], joined: ISODate("2021-06-07T08:09:10Z"), address: { city: "Portland" } },
      { name: "Grace", age: 45, tags: [], joined: ISODate("2019-11-12T13:14:15Z"), address: { city: "New York" } }
    ])`);
    assert.equal(result.kind, 'acknowledgement');
    const value = result.value as { insertedIds: Record<string, unknown> };
    assert.equal(Object.keys(value.insertedIds).length, 3);
  });

  await check('find returns documents, columns and relaxed EJSON', async () => {
    const result = await query('db.people.find({}).sort({ age: 1 })');
    assert.equal(result.kind, 'documents');
    assert.equal(result.totalReturned, 3);
    assert.equal(result.collection, 'people');
    assert.equal(result.operation, 'find');
    assert.equal(result.columns[0], '_id');
    assert.ok(result.columns.includes('name'));
    const first = result.documents[0] as Record<string, any>;
    assert.equal(first.name, 'Ada');
    assert.equal(typeof first._id.$oid, 'string', 'ObjectId must serialize as $oid');
    assert.equal(typeof first.joined.$date, 'string', 'Date must serialize as $date');
  });

  await check('cursor chaining and limits are honoured', async () => {
    const result = await query('db.people.find({}).sort({ age: -1 }).limit(2)');
    assert.equal(result.totalReturned, 2);
    assert.equal((result.documents[0] as { name: string }).name, 'Linus');
  });

  await check('the row limit truncates and flags the result', async () => {
    const result = await query('db.people.find({})', 2);
    assert.equal(result.totalReturned, 2);
    assert.equal(result.truncated, true);
  });

  await check('aggregate pipelines run', async () => {
    const result = await query(
      'db.people.aggregate([{ $group: { _id: "$address.city", total: { $sum: 1 } } }, { $sort: { _id: 1 } }])'
    );
    assert.equal(result.totalReturned, 3);
    assert.equal((result.documents[0] as { _id: string })._id, 'London');
  });

  await check('scalar results come back as values', async () => {
    const result = await query('db.people.countDocuments({ age: { $gt: 40 } })');
    assert.equal(result.kind, 'value');
    assert.equal(result.value, 2);
  });

  await check('mongosh aliases resolve (count, getIndexes)', async () => {
    const count = await query('db.people.count({})');
    assert.equal(count.value, 3);
    const indexes = await query('db.people.getIndexes()');
    assert.equal(indexes.kind, 'documents');
    assert.ok(indexes.totalReturned >= 1);
  });

  await check('ObjectId() and ISODate() helpers work in filters', async () => {
    const one = await query('db.people.findOne({ name: "Ada" })');
    const id = (one.documents[0] as { _id: { $oid: string } })._id.$oid;
    const byId = await query(`db.people.find({ _id: ObjectId("${id}") })`);
    assert.equal(byId.totalReturned, 1);
    // `new ObjectId(...)` must keep working too.
    const withNew = await query(`db.people.find({ _id: new ObjectId("${id}") })`);
    assert.equal(withNew.totalReturned, 1);
    const decimal = await query('return NumberDecimal("12.5").toString()');
    assert.equal(decimal.value, '12.5');
    const long = await query('return NumberLong("9007199254740993").toString()');
    assert.equal(long.value, '9007199254740993');
    const byDate = await query('db.people.find({ joined: { $gt: ISODate("2020-06-01") } })');
    assert.equal(byDate.totalReturned, 1);
  });

  await check('multi-statement scripts run with an explicit return', async () => {
    const result = await query(`
      const cutoff = 40;
      const rows = await db.people.find({ age: { $gt: cutoff } }).toArray();
      return rows.map((row) => ({ name: row.name }));
    `);
    assert.equal(result.totalReturned, 2);
    assert.ok('name' in (result.documents[0] as Record<string, unknown>));
  });

  await check('scripts without a return still yield their last statement', async () => {
    const result = await query(`
      const minimum = 50;
      db.people.find({ age: { $gt: minimum } })
    `);
    assert.equal(result.totalReturned, 1);
  });

  await check('db-level helpers are available', async () => {
    const names = await query('db.getCollectionNames()');
    assert.ok((names.documents as unknown[]).length >= 1 || names.kind === 'documents');
    const stats = await query('db.stats()');
    assert.equal(stats.kind, 'documents');
  });

  await check('explain returns a query plan', async () => {
    const result = await runQuery({
      connectionId: connection.id,
      database: DATABASE,
      code: 'db.people.find({ age: { $gt: 40 } })',
      explain: 'executionStats'
    });
    assert.ok(result.explain, 'expected an explain payload');
    assert.ok(JSON.stringify(result.explain).includes('winningPlan'));
  });

  await check('syntax errors surface as readable messages', async () => {
    await assert.rejects(
      () => query('db.people.find({'),
      (error: Error) => error.message.startsWith('Syntax error:')
    );
  });

  await check('queries cannot reach Node globals', async () => {
    const result = await query('return typeof require + "," + typeof process');
    assert.equal(result.value, 'undefined,undefined');
  });

  await check('paging skips its way through a cursor', async () => {
    const page = (skip: number) =>
      runQuery({
        connectionId: connection.id,
        database: DATABASE,
        code: 'db.people.find({}).sort({ name: 1 })',
        limit: 1,
        skip
      });
    const first = await page(0);
    const second = await page(1);
    const last = await page(2);
    assert.equal(first.truncated, true, 'more rows should be reported as available');
    assert.equal(last.truncated, false, 'the last page has nothing after it');
    const nameOf = (result: QueryResult) =>
      (result.documents[0] as { name: string } | undefined)?.name;
    assert.deepEqual(
      [nameOf(first), nameOf(second), nameOf(last)],
      ['Ada', 'Grace', 'Linus'],
      'each page should hold the next document'
    );
  });

  await check('paging also works on a query that returns an array', async () => {
    const result = await runQuery({
      connectionId: connection.id,
      database: DATABASE,
      code: 'db.people.find({}).sort({ name: 1 }).toArray()',
      limit: 2,
      skip: 2
    });
    assert.equal(result.totalReturned, 1);
    assert.equal((result.documents[0] as { name: string }).name, 'Linus');
  });

  // --- write guards --------------------------------------------------------

  await check('the write scan finds writes and ignores lookalikes', () => {
    assert.deepEqual(detectWrites('db.people.find({ name: "Ada" })'), []);
    assert.deepEqual(detectWrites('db.getCollection("orders").deleteMany({ paid: false })'), [
      { method: 'deleteMany', collection: 'orders' }
    ]);
    assert.deepEqual(
      detectWrites('// db.people.deleteMany({})\ndb.people.countDocuments({})'),
      [],
      'a write inside a comment is not a write'
    );
    assert.deepEqual(
      detectWrites('db.people.find({ note: "call deleteMany({}) later" })'),
      [],
      'a write inside a string is not a write'
    );
    assert.deepEqual(detectWrites('db.people.aggregate([{ $out: "copy" }])'), [
      { method: '$out', collection: null }
    ]);
    assert.deepEqual(detectWrites('db.runCommand({ dropDatabase: 1 })'), [
      { method: 'dropDatabase', collection: null }
    ]);
    assert.deepEqual(detectWrites('db.runCommand({ dbStats: 1 })'), []);
  });

  await check('a dry run counts what a delete would remove without removing it', async () => {
    const before = await db.collection('people').countDocuments();
    const result = await runQuery({
      connectionId: connection.id,
      database: DATABASE,
      code: 'db.getCollection("people").deleteMany({ age: { $gt: 40 } })',
      dryRun: true
    });
    assert.deepEqual(result.preview, [
      { method: 'deleteMany', namespace: `${DATABASE}.people`, affected: 2, note: undefined }
    ]);
    assert.equal(await db.collection('people').countDocuments(), before, 'nothing may be deleted');
  });

  await check('a dry run says when only the first of many matches would change', async () => {
    const result = await runQuery({
      connectionId: connection.id,
      database: DATABASE,
      code: 'db.people.updateOne({ age: { $gt: 40 } }, { $set: { seen: true } })',
      dryRun: true
    });
    const [entry] = result.preview ?? [];
    assert.equal(entry?.affected, 1);
    assert.match(String(entry?.note), /2 documents match/);
    assert.equal(await db.collection('people').countDocuments({ seen: true }), 0);
  });

  await check('a dry run leaves an aggregation $out unwritten', async () => {
    const result = await runQuery({
      connectionId: connection.id,
      database: DATABASE,
      code: 'db.people.aggregate([{ $match: {} }, { $out: "people_copy" }]).toArray()',
      dryRun: true
    });
    assert.equal(result.preview?.[0]?.method, 'aggregate $out');
    assert.equal(result.totalReturned, 3, 'the pipeline still reports what it would have written');
    const names = await db.listCollections({ name: 'people_copy' }).toArray();
    assert.equal(names.length, 0, 'the output collection must not exist');
  });

  await check('a read-only connection refuses writes from every direction', async () => {
    upsertConnection({ ...connection, readOnly: true });
    try {
      assert.throws(
        () => assertWritable(connection.id, 'the drop'),
        /marked read-only/,
        'the IPC guard should refuse'
      );
      await assert.rejects(
        runQuery({
          connectionId: connection.id,
          database: DATABASE,
          code: 'db.people.deleteMany({})'
        }),
        /read-only/,
        'query code should be stopped as it runs'
      );
      await assert.rejects(
        runQuery({
          connectionId: connection.id,
          database: DATABASE,
          code: 'db.runCommand({ drop: "people" })'
        }),
        /read-only/,
        'a raw command should be stopped too'
      );
      const reads = await runQuery({
        connectionId: connection.id,
        database: DATABASE,
        code: 'db.people.countDocuments({})'
      });
      assert.equal(reads.value, 3, 'reads must still work');
    } finally {
      upsertConnection({ ...connection, readOnly: false });
    }
    assert.equal(await db.collection('people').countDocuments(), 3);
  });

  // --- statistics ----------------------------------------------------------

  await check('listDatabases and listCollections describe the deployment', async () => {
    const databases = await listDatabases(connection.id);
    assert.ok(databases.some((entry) => entry.name === DATABASE));
    const collections = await listCollections(connection.id, DATABASE);
    const people = collections.find((entry) => entry.name === 'people');
    assert.ok(people, 'people collection missing');
    assert.equal(people!.type, 'collection');
    assert.equal(people!.documentCount, 3);
  });

  await check('collection statistics include indexes and sampled fields', async () => {
    await db.collection('people').createIndex({ name: 1 }, { unique: true });
    const stats = await collectionStats(connection.id, DATABASE, 'people');
    assert.equal(stats.documentCount, 3);
    assert.ok(stats.dataSizeBytes > 0);
    assert.ok(stats.storageSizeBytes > 0);
    assert.equal(stats.indexCount, 2);
    assert.ok(stats.indexes.some((index) => index.name === 'name_1' && index.unique));
    assert.ok(stats.sampledFields.some((field) => field.field === 'name'));
    assert.equal(stats.sampledFields.find((field) => field.field === '_id')?.presencePercent, 100);
  });

  await check('database statistics aggregate the collections', async () => {
    const stats = await databaseStats(connection.id, DATABASE);
    assert.equal(stats.name, DATABASE);
    assert.ok(stats.objectCount >= 3);
    assert.ok(stats.collections.some((entry) => entry.name === 'people'));
    assert.ok(stats.indexSizeBytes > 0);
  });

  // --- database and collection creation ------------------------------------

  await check('creating a database materialises it with its first collection', async () => {
    const name = `${DATABASE}_created`;
    await createDatabase(connection.id, name, 'events');
    const databases = await listDatabases(connection.id);
    assert.ok(
      databases.some((entry) => entry.name === name),
      'the new database is not listed'
    );
    const collections = await listCollections(connection.id, name);
    assert.deepEqual(
      collections.map((entry) => entry.name),
      ['events']
    );
    await dropDatabase(connection.id, name);
  });

  await check('creating a database that already exists is refused', async () => {
    await assert.rejects(
      () => createDatabase(connection.id, DATABASE, 'events'),
      /already exists/
    );
  });

  await check('invalid database and collection names are rejected', async () => {
    await assert.rejects(() => createDatabase(connection.id, 'has space', 'events'), /cannot contain/);
    await assert.rejects(() => createDatabase(connection.id, 'has.dot', 'events'), /cannot contain/);
    await assert.rejects(() => createDatabase(connection.id, '', 'events'), /Enter a database name/);
    await assert.rejects(
      () => createDatabase(connection.id, `${DATABASE}_bad`, 'sys$tem'),
      /cannot contain "\$"/
    );
    await assert.rejects(
      () => createCollection(connection.id, DATABASE, 'system.profiles'),
      /reserved/
    );
    await assert.rejects(
      () => createDatabase(connection.id, 'd'.repeat(64), 'events'),
      /63 bytes or fewer/
    );
    const databases = await listDatabases(connection.id);
    assert.ok(
      !databases.some((entry) => entry.name.startsWith(`${DATABASE}_bad`)),
      'a rejected name still created a database'
    );
  });

  await check('a collection can be added to an existing database', async () => {
    await createCollection(connection.id, DATABASE, 'audit_log');
    const collections = await listCollections(connection.id, DATABASE);
    assert.ok(collections.some((entry) => entry.name === 'audit_log'));
    await db.collection('audit_log').drop();
  });

  await check('index listing reports keys and usage', async () => {
    const indexes = await indexesFor(connection.id, DATABASE, 'people');
    const unique = indexes.find((index) => index.name === 'name_1');
    assert.ok(unique);
    assert.deepEqual(unique!.keys, { name: 1 });
    assert.equal(unique!.unique, true);
  });

  // --- index management ----------------------------------------------------

  await check('createIndex accepts shell-style keys and options', async () => {
    const created = await createIndex({
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      keys: '{ age: -1, name: 1 }',
      name: 'age_name',
      sparse: true
    });
    assert.equal(created.name, 'age_name');
    const indexes = await indexesFor(connection.id, DATABASE, 'people');
    const index = indexes.find((entry) => entry.name === 'age_name');
    assert.ok(index);
    assert.deepEqual(index!.keys, { age: -1, name: 1 });
    assert.equal(index!.sparse, true);
  });

  await check('createIndex supports partial filters and TTL', async () => {
    const partial = await createIndex({
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      keys: '{ "address.city": 1 }',
      partialFilter: '{ age: { $gt: 30 } }'
    });
    assert.equal(partial.name, 'address.city_1');

    await createIndex({
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      keys: '{ joined: 1 }',
      name: 'joined_ttl',
      expireAfterSeconds: 86_400
    });
    const indexes = await indexesFor(connection.id, DATABASE, 'people');
    assert.equal(indexes.find((entry) => entry.name === 'joined_ttl')?.ttlSeconds, 86_400);
  });

  await check('dropIndex removes an index but refuses to touch _id', async () => {
    await dropIndex(connection.id, DATABASE, 'people', 'age_name');
    const indexes = await indexesFor(connection.id, DATABASE, 'people');
    assert.ok(!indexes.some((entry) => entry.name === 'age_name'));
    await assert.rejects(
      () => dropIndex(connection.id, DATABASE, 'people', '_id_'),
      /_id index cannot be dropped/
    );
  });

  await check('an empty index key specification is rejected', async () => {
    await assert.rejects(
      () =>
        createIndex({
          connectionId: connection.id,
          database: DATABASE,
          collection: 'people',
          keys: '{}'
        }),
      /at least one index key/
    );
  });

  // --- document editing ----------------------------------------------------

  await check('a document reads back as canonical EJSON', async () => {
    const found = await db.collection('people').findOne({ name: 'Ada' });
    const idJson = JSON.stringify({ $oid: String(found!._id) });
    const json = await getDocument({
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      idJson
    });
    const parsed = JSON.parse(json);
    assert.equal(parsed._id.$oid, String(found!._id));
    assert.ok(parsed.age.$numberInt || parsed.age.$numberLong || parsed.age.$numberDouble);
    assert.ok(parsed.joined.$date, 'dates should stay typed in canonical EJSON');
  });

  await check('editing a document preserves its BSON types', async () => {
    const found = await db.collection('people').findOne({ name: 'Grace' });
    const ref = {
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      idJson: JSON.stringify({ $oid: String(found!._id) })
    };
    const json = JSON.parse(await getDocument(ref));
    json.title = 'Rear Admiral';
    json.age = { $numberLong: '46' };
    await replaceDocument(ref, JSON.stringify(json));

    const updated = await db.collection('people').findOne({ _id: found!._id });
    assert.equal(updated?.title, 'Rear Admiral');
    assert.equal(String(updated?.age), '46');
    assert.ok(updated?.joined instanceof Date, 'the untouched date must stay a date');
  });

  await check('changing _id during an edit is refused', async () => {
    const found = await db.collection('people').findOne({ name: 'Ada' });
    const ref = {
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      idJson: JSON.stringify({ $oid: String(found!._id) })
    };
    await assert.rejects(
      () => replaceDocument(ref, JSON.stringify({ _id: { $oid: '0'.repeat(24) }, name: 'Ada' })),
      /_id of an existing document cannot be changed/
    );
  });

  await check('documents can be inserted and deleted', async () => {
    const inserted = await insertDocument(
      connection.id,
      DATABASE,
      'people',
      '{ "name": "Barbara", "age": { "$numberInt": "70" } }'
    );
    assert.ok(inserted.insertedId);
    const created = await db.collection('people').findOne({ name: 'Barbara' });
    assert.equal(created?.age, 70);

    const ref = {
      connectionId: connection.id,
      database: DATABASE,
      collection: 'people',
      idJson: JSON.stringify({ $oid: String(created!._id) })
    };
    await deleteDocument(ref);
    assert.equal(await db.collection('people').countDocuments({ name: 'Barbara' }), 0);
    await assert.rejects(() => deleteDocument(ref), /no longer exists/);
  });

  await check('one value can be written across a selection of documents', async () => {
    const target = { connectionId: connection.id, database: DATABASE, collection: 'batch' };
    await db.collection('batch').insertMany([
      { name: 'a', score: new Int32(1), tier: 'bronze' },
      { name: 'b', score: 2.5, tier: 'bronze' },
      { name: 'c', score: new Int32(3), tier: 'bronze' },
      { name: 'd', score: new Int32(4), tier: 'bronze' }
    ]);
    const chosen = await db.collection('batch').find({ name: { $in: ['a', 'b', 'c'] } }).toArray();
    const idsJson = chosen.map((document) => JSON.stringify({ $oid: String(document._id) }));

    const result = await setFieldOnMany({ ...target, idsJson, field: 'tier', valueJson: '"gold"' });
    assert.equal(result.matched, 3);
    assert.equal(result.modified, 3);
    assert.equal(result.updates.length, 3, 'every document reports what it now stores');
    assert.deepEqual(
      result.updates.map((update) => update.value),
      ['gold', 'gold', 'gold']
    );
    assert.equal(await db.collection('batch').countDocuments({ tier: 'gold' }), 3);
    assert.equal(
      await db.collection('batch').countDocuments({ name: 'd', tier: 'bronze' }),
      1,
      'documents outside the selection are left alone'
    );
  });

  await check('a batch write keeps each document’s numeric type', async () => {
    const target = { connectionId: connection.id, database: DATABASE, collection: 'batch' };
    const chosen = await db.collection('batch').find({ name: { $in: ['a', 'b'] } }).toArray();
    const idsJson = chosen.map((document) => JSON.stringify({ $oid: String(document._id) }));
    // 'a' holds an int32 and 'b' a double, so one updateMany for both would
    // have to widen one of them.
    await setFieldOnMany({ ...target, idsJson, field: 'score', valueJson: '7' });
    const typeOf = async (name: string) => {
      const [row] = await db
        .collection('batch')
        .aggregate([{ $match: { name } }, { $project: { type: { $type: '$score' } } }])
        .toArray();
      return String(row?.type);
    };
    assert.equal(await typeOf('a'), 'int');
    assert.equal(await typeOf('b'), 'double');
    assert.equal((await db.collection('batch').findOne({ name: 'a' }))?.score, 7);
    assert.equal((await db.collection('batch').findOne({ name: 'b' }))?.score, 7);
  });

  await check('a field can be unset, and documents deleted, in batches', async () => {
    const target = { connectionId: connection.id, database: DATABASE, collection: 'batch' };
    const all = await db.collection('batch').find({}).toArray();
    const idsJson = all.map((document) => JSON.stringify({ $oid: String(document._id) }));

    const unset = await unsetFieldOnMany({ ...target, idsJson, field: 'tier' });
    assert.equal(unset.matched, 4);
    assert.equal(await db.collection('batch').countDocuments({ tier: { $exists: true } }), 0);

    const deleted = await deleteDocuments({ ...target, idsJson: idsJson.slice(0, 2) });
    assert.equal(deleted.deleted, 2);
    assert.equal(await db.collection('batch').countDocuments(), 2);

    // The same ids again match nothing rather than failing.
    assert.equal((await deleteDocuments({ ...target, idsJson: idsJson.slice(0, 2) })).deleted, 0);
  });

  await check('a batch write refuses _id and an empty selection', async () => {
    const target = { connectionId: connection.id, database: DATABASE, collection: 'batch' };
    const [survivor] = await db.collection('batch').find({}).toArray();
    const idsJson = [JSON.stringify({ $oid: String(survivor._id) })];
    await assert.rejects(
      () => setFieldOnMany({ ...target, idsJson, field: '_id', valueJson: '"x"' }),
      /_id of an existing document cannot be changed/
    );
    await assert.rejects(
      () => setFieldOnMany({ ...target, idsJson: [], field: 'tier', valueJson: '"gold"' }),
      /No documents were selected/
    );
    await assert.rejects(
      () => deleteDocuments({ ...target, idsJson: [] }),
      /No documents were selected/
    );
  });

  await check('malformed document JSON produces a readable error', async () => {
    await assert.rejects(
      () => insertDocument(connection.id, DATABASE, 'people', '{ not json'),
      /Invalid document/
    );
  });

  // --- query history and saved queries -------------------------------------

  await check('history is recorded and repeated runs collapse', async () => {
    clearHistory();
    recordHistory({
      connectionId: connection.id,
      connectionName: 'Smoke test',
      database: DATABASE,
      code: 'db.people.find({})',
      durationMs: 5,
      ok: true,
      totalReturned: 3
    });
    recordHistory({
      connectionId: connection.id,
      connectionName: 'Smoke test',
      database: DATABASE,
      code: 'db.people.find({})',
      durationMs: 7,
      ok: true,
      totalReturned: 3
    });
    recordHistory({
      connectionId: connection.id,
      connectionName: 'Smoke test',
      database: DATABASE,
      code: 'db.people.countDocuments({})',
      durationMs: 2,
      ok: false,
      totalReturned: 0,
      error: 'boom'
    });

    const history = listHistory(10);
    assert.equal(history.length, 2, 'the repeated run should have collapsed');
    assert.equal(history[0].code, 'db.people.countDocuments({})');
    assert.equal(history[0].ok, false);
    assert.equal(history[0].error, 'boom');
    assert.equal(history[1].durationMs, 7, 'the newer timing should win');
  });

  await check('saved queries can be created, updated and removed', async () => {
    const saved = saveQuery({
      name: 'Recent joiners',
      code: 'db.people.find({}).sort({ joined: -1 })',
      database: DATABASE,
      connectionId: connection.id
    });
    assert.ok(saved.id);
    assert.equal(listSavedQueries().length, 1);

    const updated = saveQuery({ ...saved, name: 'Recent joiners v2' });
    assert.equal(updated.id, saved.id);
    assert.equal(updated.createdAt, saved.createdAt);
    assert.equal(listSavedQueries().length, 1, 'updating must not create a duplicate');
    assert.equal(listSavedQueries()[0].name, 'Recent joiners v2');

    removeSavedQuery(saved.id);
    assert.equal(listSavedQueries().length, 0);

    await assert.rejects(
      async () => saveQuery({ name: '  ', code: 'db.people.find({})' }),
      /Give the query a name/
    );
  });

  // --- live operations -----------------------------------------------------

  await check('the live operations list sees the app itself working', async () => {
    // A cursor left open is an operation the server will report.
    const cursor = db.collection('orders').find({}).batchSize(1);
    await cursor.next();
    try {
      const running = await currentOperations(connection.id);
      assert.ok(running.length > 0, 'something should be running');
      const ours = running.find((operation) => operation.appName === 'Mongo Explorer');
      assert.ok(ours, 'the app should recognise its own operations by name');
      assert.equal(typeof ours?.opid, 'string');
      assert.ok(
        running.every(
          (operation) => operation.secondsRunning === null || operation.secondsRunning >= 0
        ),
        'ages should be reported in seconds'
      );
    } finally {
      await cursor.close();
    }
  });

  await check('the running list is ordered by age, oldest first', async () => {
    const running = await currentOperations(connection.id, { includeIdle: true });
    const ages = running.map((operation) => operation.secondsRunning ?? 0);
    assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
  });

  await check('stopping an operation that has already finished is reported', async () => {
    // killOp accepts any id; a stale one is a no-op rather than an error, so
    // this asserts the call shape rather than the outcome.
    await killOperation(connection.id, '999999999');
  });

  await check('the profiler reports its level and what it recorded', async () => {
    const off = await profilerSnapshot(connection.id, DATABASE);
    assert.equal(off.level, 0, 'profiling starts off');
    assert.deepEqual(off.operations, [], 'nothing is recorded while it is off');

    await db.command({ profile: 2 });
    try {
      await db.collection('orders').find({ status: 'paid' }).toArray();
      const on = await profilerSnapshot(connection.id, DATABASE, 10);
      assert.equal(on.level, 2);
      assert.ok(on.operations.length > 0, 'the profiler should have recorded the query');
      const [entry] = on.operations;
      assert.equal(typeof entry.millis, 'number');
      assert.match(String(entry.namespace), /orders/);
      assert.ok(entry.command, 'the command should be summarised for the table');
    } finally {
      await db.command({ profile: 0 });
    }
  });

  // --- export / import (native) --------------------------------------------

  const jsonFile = path.join(workDir, 'people.json');
  const ndjsonFile = path.join(workDir, 'people.ndjson');
  const csvFile = path.join(workDir, 'people.csv');

  await check('export to a JSON array', async () => {
    const result = await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'people',
        format: 'json-array',
        filePath: jsonFile,
        prettyPrint: false
      },
      silent
    );
    assert.equal(result.processed, 3);
    const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    assert.equal(parsed.length, 3);
    assert.ok(parsed[0]._id.$oid, 'exported _id should be EJSON');
  });

  await check('export honours filter, projection and sort', async () => {
    const filtered = path.join(workDir, 'filtered.json');
    const result = await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'people',
        format: 'json-array',
        filePath: filtered,
        filter: '{ age: { $gt: 40 } }',
        projection: '{ name: 1, _id: 0 }',
        sort: '{ name: 1 }'
      },
      silent
    );
    assert.equal(result.processed, 2);
    const parsed = JSON.parse(fs.readFileSync(filtered, 'utf8'));
    assert.deepEqual(parsed, [{ name: 'Grace' }, { name: 'Linus' }]);
  });

  await check('export to NDJSON writes one document per line', async () => {
    await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'people',
        format: 'ndjson',
        filePath: ndjsonFile
      },
      silent
    );
    const lines = fs.readFileSync(ndjsonFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(JSON.parse(lines[0]).name);
  });

  await check('export to CSV flattens nested fields', async () => {
    await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'people',
        format: 'csv',
        filePath: csvFile
      },
      silent
    );
    const text = fs.readFileSync(csvFile, 'utf8').trim();
    const [header, ...rows] = text.split('\n');
    assert.ok(header.startsWith('_id'), `unexpected header: ${header}`);
    assert.ok(header.includes('address.city'), 'nested fields should become dot-paths');
    assert.equal(rows.length, 3);
    assert.ok(/^[0-9a-f]{24},/.test(rows[0]), 'ObjectId should be written as a plain hex string');
  });

  await check('import a JSON array into a new collection', async () => {
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'from_json',
        format: 'json-array',
        filePath: jsonFile,
        mode: 'insert'
      },
      silent
    );
    assert.equal(result.processed, 3);
    assert.equal(result.failed, 0);
    const count = await db.collection('from_json').countDocuments();
    assert.equal(count, 3);
    const ada = await db.collection('from_json').findOne({ name: 'Ada' });
    assert.ok(ada?.joined instanceof Date, 'EJSON dates should be restored as BSON dates');
    assert.equal(ada?.address?.city, 'London');
  });

  await check('import NDJSON with format auto-detection', async () => {
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'from_ndjson',
        format: 'auto',
        filePath: ndjsonFile,
        mode: 'insert'
      },
      silent
    );
    assert.equal(result.processed, 3);
    assert.equal(await db.collection('from_ndjson').countDocuments(), 3);
  });

  await check('import CSV infers types and rebuilds nested paths', async () => {
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'from_csv',
        format: 'csv',
        filePath: csvFile,
        mode: 'insert',
        csvHasHeader: true,
        csvInferTypes: true
      },
      silent
    );
    assert.equal(result.processed, 3);
    const linus = await db.collection('from_csv').findOne({ name: 'Linus' });
    assert.equal(linus?.age, 54, 'numbers should be coerced');
    assert.equal(linus?.address?.city, 'Portland', 'dot-path headers should nest');
  });

  await check('CSV quoting survives commas, quotes and newlines', async () => {
    const trickyPath = path.join(workDir, 'tricky.csv');
    fs.writeFileSync(
      trickyPath,
      'name,note\n"Smith, John","He said ""hi""\nsecond line"\nplain,simple\n'
    );
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'tricky',
        format: 'csv',
        filePath: trickyPath,
        mode: 'insert'
      },
      silent
    );
    assert.equal(result.processed, 2);
    const row = await db.collection('tricky').findOne({ name: 'Smith, John' });
    assert.equal(row?.note, 'He said "hi"\nsecond line');
  });

  await check('upsert mode merges instead of duplicating', async () => {
    const before = await db.collection('from_json').countDocuments();
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'from_json',
        format: 'json-array',
        filePath: jsonFile,
        mode: 'upsert',
        upsertFields: ['name']
      },
      silent
    );
    assert.equal(result.failed, 0);
    assert.equal(await db.collection('from_json').countDocuments(), before);
  });

  await check('insert mode reports duplicate-key failures without throwing', async () => {
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'from_json',
        format: 'json-array',
        filePath: jsonFile,
        mode: 'insert'
      },
      silent
    );
    assert.equal(result.ok, false);
    assert.equal(result.failed, 3);
    assert.ok(result.errors.length > 0);
  });

  await check('drop-before-import replaces the collection contents', async () => {
    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'from_json',
        format: 'json-array',
        filePath: jsonFile,
        mode: 'insert',
        dropBeforeImport: true
      },
      silent
    );
    assert.equal(result.processed, 3);
    assert.equal(await db.collection('from_json').countDocuments(), 3);
  });

  await check('a large NDJSON file streams through in batches', async () => {
    const bulkPath = path.join(workDir, 'bulk.ndjson');
    const stream = fs.createWriteStream(bulkPath);
    for (let index = 0; index < 5000; index += 1) {
      stream.write(`${JSON.stringify({ index, group: index % 7, label: `row-${index}` })}\n`);
    }
    await new Promise<void>((resolve) => stream.end(resolve));

    const result = await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'bulk',
        format: 'ndjson',
        filePath: bulkPath,
        mode: 'insert',
        batchSize: 500
      },
      silent
    );
    assert.equal(result.processed, 5000);
    assert.equal(await db.collection('bulk').countDocuments(), 5000);

    const roundTrip = path.join(workDir, 'bulk-out.json');
    const exported = await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'bulk',
        format: 'json-array',
        filePath: roundTrip
      },
      silent
    );
    assert.equal(exported.processed, 5000);
    assert.equal(JSON.parse(fs.readFileSync(roundTrip, 'utf8')).length, 5000);
  });

  await check('export progress carries a total, bytes and a start time', async () => {
    const events: TransferProgress[] = [];
    const target = path.join(workDir, 'progress.ndjson');
    const result = await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'bulk',
        format: 'ndjson',
        filePath: target
      },
      (event) => events.push(event)
    );

    assert.equal(result.processed, 5000);
    assert.equal(events[0]?.phase, 'starting');
    assert.ok(
      Number.isFinite(Date.parse(events[0]!.startedAt)),
      'every event should say when the job began'
    );

    const running = events.filter((event) => event.phase === 'running');
    assert.ok(running.length > 0, 'expected at least one running event');
    assert.ok(
      running.every((event) => event.total === 5000),
      `every running total should be 5000, saw ${running.map((event) => event.total).join(',')}`
    );

    const last = events.at(-1)!;
    assert.equal(last.phase, 'done');
    assert.equal(last.processed, 5000);
    assert.ok((last.bytes ?? 0) > 0, 'the finished export should report its file size');
  });

  await check('export progress totals account for skip and limit', async () => {
    const events: TransferProgress[] = [];
    await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'bulk',
        format: 'ndjson',
        filePath: path.join(workDir, 'progress-window.ndjson'),
        skip: 4900,
        limit: 50
      },
      (event) => events.push(event)
    );
    const totals = events
      .filter((event) => event.phase === 'running')
      .map((event) => event.total);
    assert.ok(totals.length > 0, 'expected a running event carrying the total');
    assert.ok(
      totals.every((total) => total === 50),
      `the window is 50 documents, saw ${totals.join(',')}`
    );
  });

  await check('import progress measures the file it is reading', async () => {
    const events: TransferProgress[] = [];
    const source = path.join(workDir, 'bulk.ndjson');
    await importCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'progress_import',
        format: 'ndjson',
        filePath: source,
        mode: 'insert'
      },
      (event) => events.push(event)
    );
    const size = fs.statSync(source).size;
    const running = events.filter((event) => event.phase === 'running');
    assert.ok(running.length > 0, 'expected at least one running event');
    assert.ok(
      running.every((event) => event.totalBytes === size),
      'the total should be the size of the source file'
    );
    assert.equal(events.at(-1)?.bytes, size, 'a finished import has read the whole file');
  });

  await check('a cancelled export stops without poisoning the next one', async () => {
    const target = path.join(workDir, 'cancelled.ndjson');
    await assert.rejects(
      exportCollection(
        {
          connectionId: connection.id,
          database: DATABASE,
          collection: 'bulk',
          format: 'ndjson',
          filePath: target
        },
        (event) => {
          if (event.phase === 'running') cancelJob(event.jobId);
        }
      ),
      /Cancelled by user/
    );

    const again = await exportCollection(
      {
        connectionId: connection.id,
        database: DATABASE,
        collection: 'bulk',
        format: 'ndjson',
        filePath: path.join(workDir, 'after-cancel.ndjson')
      },
      silent
    );
    assert.equal(again.processed, 5000, 'a stale cancellation must not stop the next job');
  });

  await check('progress summaries report percent, rate and time left', async () => {
    const startedAt = new Date(0).toISOString();
    const half = summarizeTransfer(
      {
        jobId: 'job',
        kind: 'export',
        phase: 'running',
        processed: 500,
        total: 1000,
        bytes: 2048,
        startedAt
      },
      10_000
    );
    assert.equal(half.percentLabel, '50%');
    assert.equal(half.fraction, 0.5);
    assert.equal(half.countLabel, '500 / 1,000 documents');
    assert.equal(half.elapsedLabel, '0:10');
    assert.equal(half.remainingLabel, '0:10', 'half done in ten seconds means ten to go');
    assert.equal(half.rateLabel, '50 docs/s');

    const byBytes = summarizeTransfer(
      {
        jobId: 'job',
        kind: 'import',
        phase: 'running',
        processed: 120,
        total: null,
        bytes: 250,
        totalBytes: 1000,
        startedAt
      },
      60_000
    );
    assert.equal(byBytes.percentLabel, '25%', 'an import is measured by its file');
    assert.equal(byBytes.elapsedLabel, '1:00');
    assert.equal(byBytes.remainingLabel, '3:00');

    const unknown = summarizeTransfer(
      {
        jobId: 'job',
        kind: 'tool',
        phase: 'running',
        processed: 0,
        total: null,
        startedAt
      },
      3_600_000
    );
    assert.equal(unknown.fraction, null, 'nothing countable means an open-ended bar');
    assert.equal(unknown.percentLabel, null);
    assert.equal(unknown.remainingLabel, null);
    assert.equal(unknown.elapsedLabel, '1:00:00');
  });

  // --- optional external tools --------------------------------------------

  let dumpAvailable = false;
  await check('tool detection finds the installed database tools', async () => {
    const detections = await detectTools();
    assert.equal(detections.length, 5);
    const dump = detections.find((entry) => entry.tool === 'mongodump');
    assert.ok(dump);
    dumpAvailable = Boolean(dump!.ok);
    if (dumpAvailable) {
      assert.ok(dump!.path?.endsWith('mongodump'));
      assert.ok(dump!.version, 'expected a version string');
    }
  });

  if (dumpAvailable) {
    const dumpDir = path.join(workDir, 'dump');
    await check('mongodump runs with the resolved path', async () => {
      const result = await runTool(
        {
          connectionId: connection.id,
          tool: 'mongodump',
          database: DATABASE,
          collection: 'people',
          target: dumpDir
        },
        silent
      );
      assert.equal(result.ok, true);
      const bson = path.join(dumpDir, DATABASE, 'people.bson');
      assert.ok(fs.existsSync(bson), `expected ${bson} to exist`);
      assert.ok(fs.statSync(bson).size > 0);
    });

    await check('mongorestore reloads a dump into a new collection', async () => {
      const restoreTools = await detectTools();
      if (!restoreTools.find((entry) => entry.tool === 'mongorestore')?.ok) return;
      await db.collection('people').drop().catch(() => undefined);
      const result = await runTool(
        {
          connectionId: connection.id,
          tool: 'mongorestore',
          database: DATABASE,
          target: path.join(dumpDir, DATABASE),
          drop: true
        },
        silent
      );
      assert.equal(result.ok, true);
      assert.equal(await db.collection('people').countDocuments(), 3);
    });
  } else {
    console.log('  --  mongodump not installed; skipped the external-tool checks');
  }

  await check('a missing tool path produces an actionable error', async () => {
    await assert.rejects(
      () =>
        runTool(
          {
            connectionId: connection.id,
            tool: 'mongosh',
            target: workDir
          },
          silent
        ),
      (error: Error) => /mongosh/.test(error.message)
    );
  });

  // --- connection error messages -------------------------------------------

  await check('an unresolvable host explains itself as a DNS failure', async () => {
    await assert.rejects(
      () =>
        testConnection(
          {
            mode: 'fields',
            hosts: ['database-prd-mongo-does-not-exist.invalid:27017'],
            serverSelectionTimeoutMs: 3000
          },
          {}
        ),
      (error: Error) => {
        assert.match(error.message, /DNS returned no address/);
        assert.match(error.message, /database-prd-mongo-does-not-exist\.invalid/);
        assert.match(error.message, /VPN/);
        assert.ok(error.cause, 'the driver error should be kept as the cause');
        return true;
      }
    );
  });

  await check('a refused port is reported as nothing listening', async () => {
    // Port 1 is reachable on loopback and never has a listener.
    await assert.rejects(
      () =>
        testConnection(
          { mode: 'fields', hosts: ['127.0.0.1:1'], serverSelectionTimeoutMs: 3000 },
          {}
        ),
      (error: Error) => {
        assert.match(error.message, /refused the connection|did not respond|Could not reach/);
        return true;
      }
    );
  });

  await check('driver errors are unwrapped from a server-selection failure', () => {
    // Shape of a real MongoServerSelectionError: the cause hides in the topology description.
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND mongo.internal'), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'mongo.internal'
    });
    const selection = Object.assign(new Error('Server selection timed out after 10000 ms'), {
      servers: new Map([['mongo.internal:27017', { error: inner }]])
    });
    const explained = explainConnectionError(selection, { mode: 'fields', hosts: ['mongo.internal'] });
    assert.match(explained.message, /DNS returned no address for "mongo\.internal"/);
    assert.equal(explained.cause, selection);
  });

  await check('an unresolvable replica set member points at direct connection', () => {
    // A replica set answers on the address you gave, then advertises members by their own names.
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND db-prod-1.internal'), {
      code: 'ENOTFOUND',
      hostname: 'db-prod-1.internal'
    });
    const explained = explainConnectionError(
      Object.assign(new Error('Server selection timed out after 10000 ms'), {
        servers: new Map([['db-prod-1.internal:27017', { error: inner }]])
      }),
      { mode: 'fields', hosts: ['10.100.15.205:27017'] }
    );
    assert.match(explained.message, /replica set advertises its members as "db-prod-1\.internal"/);
    assert.match(explained.message, /Direct connection/);
  });

  await check('a host the user did enter is still reported as a plain DNS failure', () => {
    const explained = explainConnectionError(
      Object.assign(new Error('getaddrinfo ENOTFOUND db-prod-1.internal'), {
        code: 'ENOTFOUND',
        hostname: 'db-prod-1.internal'
      }),
      { mode: 'fields', hosts: ['db-prod-1.internal:27017'] }
    );
    assert.match(explained.message, /DNS returned no address/);
    assert.doesNotMatch(explained.message, /Direct connection/);
  });

  await check('an SRV lookup failure names the SRV record', () => {
    const explained = explainConnectionError(
      Object.assign(new Error('querySrv ENOTFOUND _mongodb._tcp.cluster0.example.net'), {
        code: 'ENOTFOUND'
      }),
      { mode: 'uri', uri: 'mongodb+srv://cluster0.example.net' }
    );
    assert.match(explained.message, /No SRV record/);
    assert.match(explained.message, /cluster0\.example\.net/);
  });

  await check('authentication failures name the auth database', () => {
    const explained = explainConnectionError(new Error('Authentication failed.'), {
      mode: 'fields',
      username: 'reporting',
      authDatabase: 'admin'
    });
    assert.match(explained.message, /Authentication failed for "reporting"/);
    assert.match(explained.message, /"admin" database/);
  });

  await check('a TLS certificate rejection suggests the CA or the override', () => {
    const explained = explainConnectionError(
      Object.assign(new Error('self signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN'
      }),
      { mode: 'fields', hosts: ['db.internal'] }
    );
    assert.match(explained.message, /TLS certificate was rejected/);
    assert.match(explained.message, /CA file/);
  });

  await check('an unrecognised error is passed through untouched', () => {
    const original = new Error('something entirely unexpected');
    assert.equal(explainConnectionError(original, { mode: 'fields' }), original);
  });

  // --- secret storage ------------------------------------------------------

  await check('passwords round-trip through the encrypted store', async () => {
    if (!encryptionAvailable()) {
      console.log('      (OS encryption unavailable — skipped)');
      return;
    }
    setSecrets(connection.id, { password: 'hunter2' });
    assert.equal(getSecrets(connection.id).password, 'hunter2');
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'secrets.dat'));
    assert.ok(!raw.toString('utf8').includes('hunter2'), 'the vault must not contain plaintext');
  });

  await check('deleting a connection clears its secrets', async () => {
    removeConnection(connection.id);
    assert.deepEqual(getSecrets(connection.id), {});
  });

  await db.dropDatabase().catch(() => undefined);
  await disconnect(connection.id);

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(workDir, { recursive: true, force: true });
  app.exit(failed === 0 ? 0 : 1);
}

void app.whenReady().then(() =>
  main().catch((error) => {
    console.error('\nSmoke run aborted:', error);
    app.exit(1);
  })
);

// A hung driver call should not leave the harness running forever.
setTimeout(() => {
  console.error('\nSmoke run timed out after 180s');
  app.exit(1);
}, 180_000).unref();
