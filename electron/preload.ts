import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ConnectionConfig,
  ConnectionSecrets,
  ExportRequest,
  ImportRequest,
  QueryRequest,
  RendererApi,
  ToolRunRequest,
  TransferProgress
} from '../shared/types.js';

const PROGRESS_CHANNEL = 'transfer:progress';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

/**
 * The only bridge between the renderer and Node. Context isolation stays on and
 * the renderer never touches `ipcRenderer` or the MongoDB driver directly.
 */
const api: RendererApi = {
  connections: {
    list: () => invoke('connections:list'),
    save: (config: Partial<ConnectionConfig> & { name: string }, secrets?: ConnectionSecrets) =>
      invoke('connections:save', config, secrets),
    remove: (id: string) => invoke('connections:remove', id),
    duplicate: (id: string) => invoke('connections:duplicate', id),
    test: (id: string, secrets?: ConnectionSecrets) => invoke('connections:test', id, secrets),
    testDraft: (config: Partial<ConnectionConfig>, secrets?: ConnectionSecrets) =>
      invoke('connections:testDraft', config, secrets),
    connect: (id: string, secrets?: ConnectionSecrets) =>
      invoke('connections:connect', id, secrets),
    disconnect: (id: string) => invoke('connections:disconnect', id),
    active: () => invoke('connections:active'),
    hasSavedPassword: (id: string) => invoke('connections:hasSavedPassword', id),
    exportAll: (filePath: string) => invoke('connections:exportAll', filePath),
    importAll: (filePath: string) => invoke('connections:importAll', filePath)
  },
  data: {
    listDatabases: (connectionId: string) => invoke('data:listDatabases', connectionId),
    listCollections: (connectionId: string, database: string) =>
      invoke('data:listCollections', connectionId, database),
    databaseStats: (connectionId: string, database: string) =>
      invoke('data:databaseStats', connectionId, database),
    collectionStats: (connectionId: string, database: string, collection: string) =>
      invoke('data:collectionStats', connectionId, database, collection),
    serverInfo: (connectionId: string) => invoke('data:serverInfo', connectionId),
    indexes: (connectionId: string, database: string, collection: string) =>
      invoke('data:indexes', connectionId, database, collection),
    createCollection: (connectionId: string, database: string, collection: string) =>
      invoke('data:createCollection', connectionId, database, collection),
    dropCollection: (connectionId: string, database: string, collection: string) =>
      invoke('data:dropCollection', connectionId, database, collection),
    dropDatabase: (connectionId: string, database: string) =>
      invoke('data:dropDatabase', connectionId, database)
  },
  query: {
    run: (request: QueryRequest) => invoke('query:run', request)
  },
  transfer: {
    exportCollection: (request: ExportRequest) => invoke('transfer:export', request),
    importCollection: (request: ImportRequest) => invoke('transfer:import', request),
    cancel: (jobId: string) => invoke('transfer:cancel', jobId),
    onProgress: (handler: (progress: TransferProgress) => void) => {
      const listener = (_event: unknown, progress: TransferProgress) => handler(progress);
      ipcRenderer.on(PROGRESS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(PROGRESS_CHANNEL, listener);
    }
  },
  tools: {
    detect: () => invoke('tools:detect'),
    run: (request: ToolRunRequest) => invoke('tools:run', request)
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch: Partial<AppSettings>) => invoke('settings:update', patch)
  },
  dialog: {
    openFile: (options) => invoke('dialog:openFile', options),
    openDirectory: (options) => invoke('dialog:openDirectory', options),
    saveFile: (options) => invoke('dialog:saveFile', options)
  },
  app: {
    version: () => invoke('app:version'),
    openExternal: (url: string) => invoke('app:openExternal', url),
    onNewTab: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on('menu:new-tab', listener);
      return () => ipcRenderer.removeListener('menu:new-tab', listener);
    }
  }
};

contextBridge.exposeInMainWorld('api', api);
