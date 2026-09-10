import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
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
  getConnection,
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
  getDocument,
  indexesFor,
  insertDocument,
  listCollections,
  listDatabases,
  replaceDocument
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

/** Wraps a handler so the renderer always receives a Result instead of a rejection. */
function handle<Args extends unknown[], T>(
  channel: string,
  handler: (...args: Args) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      const data = await handler(...(args as Args));
      return { ok: true, data };
    } catch (error) {
      return toError(error);
    }
  });
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

  handle('connections:test', (id: string, secrets?: ConnectionSecrets) =>
    testConnection(getConnection(id), resolveSecrets(id, secrets))
  );

  handle(
    'connections:testDraft',
    (config: Partial<ConnectionConfig>, secrets?: ConnectionSecrets) =>
      testConnection(config, secrets ?? {})
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
  handle('tools:run', (request: ToolRunRequest) => runTool(request, broadcast));

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

  handle('app:openExternal', async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
    await shell.openExternal(url);
    return null;
  });
}
