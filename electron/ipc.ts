import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type {
  AppSettings,
  ConnectionConfig,
  ConnectionSecrets,
  CreateIndexRequest,
  DocumentRef,
  ExportRequest,
  ImportRequest,
  QueryRequest,
  Result,
  SavedQuery,
  ToolRunRequest,
  TransferProgress
} from '../shared/types.js';
import {
  connectionHasSavedPassword,
  duplicateConnection,
  listConnections,
  removeConnection,
  resolveSecrets,
  upsertConnection
} from './services/connections.js';
import {
  activeConnections,
  connect,
  disconnect,
  serverInfoFor,
  testConnection
} from './services/pool.js';
import { assertWritable } from './services/guards.js';
import {
  currentOperations,
  killOperation,
  profilerSnapshot
} from './services/operations.js';
import { runQuery } from './services/query.js';
import {
  collectionStats,
  createCollection,
  createDatabase,
  createIndex,
  databaseStats,
  deleteDocument,
  dropCollection,
  dropDatabase,
  dropIndex,
  duplicateDocument,
  getDocument,
  indexesFor,
  insertDocument,
  listCollections,
  listDatabases,
  replaceDocument,
  setDocumentField,
  unsetDocumentField
} from './services/stats.js';
import {
  clearHistory,
  listHistory,
  listSavedQueries,
  recordHistory,
  removeSavedQuery,
  saveQuery
} from './services/library.js';
import { loadSettings, saveSettings } from './services/store.js';
import { cancelJob, exportCollection, importCollection } from './services/transfer.js';
import { cancelToolJob, detectTools, runTool } from './services/tools.js';

/** Replaced by the esbuild bundle; see scripts/build-main.mjs. */
declare const __APP_VERSION__: string | undefined;

export const PROGRESS_CHANNEL = 'transfer:progress';

function driverVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('mongodb/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function toError(error: unknown): Result<never> {
  if (error instanceof Error) {
    const code = (error as { code?: string | number }).code;
    return {
      ok: false,
      error: {
        message: error.message,
        code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
        detail: error.stack
      }
    };
  }
  return { ok: false, error: { message: String(error) } };
}

/**
 * Every channel that changes data. Read-only connections are refused here, so
 * one list covers the whole renderer surface — add new write channels to it.
 * Query code is not on the list: it is guarded while it runs, in query.ts.
 */
const WRITE_CHANNELS = new Set([
  'data:createCollection',
  'data:createDatabase',
  'data:dropCollection',
  'data:dropDatabase',
  'data:createIndex',
  'data:dropIndex',
  'data:replaceDocument',
  'data:insertDocument',
  'data:deleteDocument',
  'data:setDocumentField',
  'data:unsetDocumentField',
  'data:duplicateDocument',
  'transfer:import',
  'ops:kill'
]);

/** Handlers take the connection id either on its own or inside their request. */
function connectionIdOf(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const candidate = (first as { connectionId?: unknown }).connectionId;
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

/** Wraps a handler so the renderer always receives a Result instead of a rejection. */
function handle<Args extends unknown[], T>(
  channel: string,
  handler: (...args: Args) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      if (WRITE_CHANNELS.has(channel)) {
        assertWritable(connectionIdOf(args), describeChannel(channel));
      }
      const data = await handler(...(args as Args));
      return { ok: true, data };
    } catch (error) {
      return toError(error);
    }
  });
}

/** Names the refused operation the way a person would say it. */
function describeChannel(channel: string): string {
  const [, action] = channel.split(':');
  const words = action.replace(/([A-Z])/g, ' $1').toLowerCase();
  return channel === 'transfer:import' ? 'the import' : `the ${words}`;
}

function broadcast(progress: TransferProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(PROGRESS_CHANNEL, progress);
  }
}

export function registerIpcHandlers(): void {
  handle('connections:list', () => listConnections());

  handle(
    'connections:save',
    (config: Partial<ConnectionConfig> & { name: string }, secrets?: ConnectionSecrets) =>
      upsertConnection(config, secrets)
  );

  handle('connections:remove', async (id: string) => {
    await disconnect(id);
    removeConnection(id);
    return null;
  });

  handle('connections:duplicate', (id: string) => duplicateConnection(id));

  // An edited draft keeps the id of the connection it came from, so a test can fall back to the
  // stored password when the user did not retype one.
  handle(
    'connections:testDraft',
    (config: Partial<ConnectionConfig>, secrets?: ConnectionSecrets) =>
      testConnection(config, config.id ? resolveSecrets(config.id, secrets) : (secrets ?? {}))
  );

  handle('connections:connect', (id: string, secrets?: ConnectionSecrets) => connect(id, secrets));

  handle('connections:disconnect', async (id: string) => {
    await disconnect(id);
    return null;
  });

  handle('connections:active', () => activeConnections());

  handle('connections:hasSavedPassword', (id: string) => connectionHasSavedPassword(id));

  handle('connections:exportAll', (filePath: string) => {
    const configs = listConnections().map((config) => ({ ...config, savePassword: false }));
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, connections: configs }, null, 2));
    return { count: configs.length };
  });

  handle('connections:importAll', (filePath: string) => {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      connections?: ConnectionConfig[];
    };
    const incoming = Array.isArray(parsed.connections) ? parsed.connections : [];
    for (const config of incoming) {
      upsertConnection({ ...config, id: undefined, savePassword: false, name: config.name });
    }
    return { count: incoming.length };
  });

  handle('data:listDatabases', (connectionId: string) => listDatabases(connectionId));
  handle('data:listCollections', (connectionId: string, database: string) =>
    listCollections(connectionId, database)
  );
  handle('data:databaseStats', (connectionId: string, database: string) =>
    databaseStats(connectionId, database)
  );
  handle('data:collectionStats', (connectionId: string, database: string, collection: string) =>
    collectionStats(connectionId, database, collection)
  );
  handle('data:serverInfo', (connectionId: string) => serverInfoFor(connectionId));
  handle('data:indexes', (connectionId: string, database: string, collection: string) =>
    indexesFor(connectionId, database, collection)
  );
  handle(
    'data:createCollection',
    async (connectionId: string, database: string, collection: string) => {
      await createCollection(connectionId, database, collection);
      return null;
    }
  );
  handle(
    'data:createDatabase',
    async (connectionId: string, database: string, collection: string) => {
      await createDatabase(connectionId, database, collection);
      return null;
    }
  );
  handle(
    'data:dropCollection',
    async (connectionId: string, database: string, collection: string) => {
      await dropCollection(connectionId, database, collection);
      return null;
    }
  );
  handle('data:dropDatabase', async (connectionId: string, database: string) => {
    await dropDatabase(connectionId, database);
    return null;
  });

  handle('data:createIndex', (request: CreateIndexRequest) => createIndex(request));
  handle(
    'data:dropIndex',
    async (connectionId: string, database: string, collection: string, indexName: string) => {
      await dropIndex(connectionId, database, collection, indexName);
      return null;
    }
  );
  handle('data:getDocument', (ref: DocumentRef) => getDocument(ref));
  handle('data:replaceDocument', async (ref: DocumentRef, documentJson: string) => {
    await replaceDocument(ref, documentJson);
    return null;
  });
  handle(
    'data:insertDocument',
    (connectionId: string, database: string, collection: string, documentJson: string) =>
      insertDocument(connectionId, database, collection, documentJson)
  );
  handle('data:deleteDocument', async (ref: DocumentRef) => {
    await deleteDocument(ref);
    return null;
  });
  handle('data:setDocumentField', (ref: DocumentRef, field: string, valueJson: string) =>
    setDocumentField(ref, field, valueJson)
  );
  handle('data:unsetDocumentField', async (ref: DocumentRef, field: string) => {
    await unsetDocumentField(ref, field);
    return null;
  });
  handle('data:duplicateDocument', (ref: DocumentRef) => duplicateDocument(ref));

  handle('query:run', async (request: QueryRequest) => {
    const connectionName = listConnections().find((c) => c.id === request.connectionId)?.name ?? '';
    try {
      const result = await runQuery(request);
      recordHistory({
        connectionId: request.connectionId,
        connectionName,
        database: request.database,
        code: request.code,
        durationMs: result.durationMs,
        ok: true,
        totalReturned: result.totalReturned
      });
      return result;
    } catch (error) {
      recordHistory({
        connectionId: request.connectionId,
        connectionName,
        database: request.database,
        code: request.code,
        durationMs: 0,
        ok: false,
        totalReturned: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });

  handle('library:history', (limit?: number) => listHistory(limit));
  handle('library:clearHistory', () => {
    clearHistory();
    return null;
  });
  handle('library:savedQueries', () => listSavedQueries());
  handle('library:saveQuery', (query: Partial<SavedQuery> & { name: string; code: string }) =>
    saveQuery(query)
  );
  handle('library:removeSavedQuery', (id: string) => {
    removeSavedQuery(id);
    return null;
  });

  handle('transfer:export', (request: ExportRequest) => exportCollection(request, broadcast));
  handle('transfer:import', (request: ImportRequest) => importCollection(request, broadcast));
  handle('transfer:cancel', (jobId: string) => {
    cancelJob(jobId);
    cancelToolJob(jobId);
    return null;
  });

  handle('tools:detect', () => detectTools());
  handle('tools:run', (request: ToolRunRequest) => {
    // mongodump and mongoexport only read; the other two load data in.
    if (request.tool === 'mongorestore' || request.tool === 'mongoimport') {
      assertWritable(request.connectionId, `${request.tool}`);
    }
    return runTool(request, broadcast);
  });

  handle('ops:current', (connectionId: string, options?: { includeIdle?: boolean }) =>
    currentOperations(connectionId, options ?? {})
  );
  handle('ops:kill', async (connectionId: string, opid: string) => {
    await killOperation(connectionId, opid);
    return null;
  });
  handle('ops:profiler', (connectionId: string, database: string, limit?: number) =>
    profilerSnapshot(connectionId, database, limit)
  );

  handle('settings:get', () => loadSettings());
  handle('settings:update', (patch: Partial<AppSettings>) => {
    const merged: AppSettings = {
      ...loadSettings(),
      ...patch,
      toolPaths: { ...loadSettings().toolPaths, ...(patch.toolPaths ?? {}) }
    };
    saveSettings(merged);
    return merged;
  });

  handle(
    'dialog:openFile',
    async (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
      const result = await dialog.showOpenDialog({
        title: options?.title,
        filters: options?.filters,
        properties: ['openFile']
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  );

  handle('dialog:openDirectory', async (options?: { title?: string }) => {
    const result = await dialog.showOpenDialog({
      title: options?.title,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(
    'dialog:saveFile',
    async (options?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => {
      const result = await dialog.showSaveDialog({
        title: options?.title,
        defaultPath: options?.defaultPath,
        filters: options?.filters
      });
      return result.canceled ? null : (result.filePath ?? null);
    }
  );

  handle('app:version', () => ({
    // Baked in at build time; app.getVersion() is unreliable when running the
    // bundled main script directly.
    app: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node,
    driver: driverVersion()
  }));

  // The renderer runs from file://, where the async clipboard API is unavailable.
  handle('app:copyToClipboard', (text: string) => {
    clipboard.writeText(text);
    return null;
  });

  handle('app:openExternal', async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
    await shell.openExternal(url);
    return null;
  });
}
