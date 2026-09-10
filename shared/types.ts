/**
 * Types shared between the Electron main process and the renderer.
 * Everything crossing the IPC boundary must be structured-clone friendly.
 */

export type AuthMechanism =
  | 'DEFAULT'
  | 'SCRAM-SHA-1'
  | 'SCRAM-SHA-256'
  | 'MONGODB-X509'
  | 'PLAIN'
  | 'MONGODB-AWS';

export type ReadPreference =
  | 'primary'
  | 'primaryPreferred'
  | 'secondary'
  | 'secondaryPreferred'
  | 'nearest';

export interface TlsConfig {
  enabled: boolean;
  allowInvalidCertificates: boolean;
  allowInvalidHostnames: boolean;
  caFile?: string;
  certificateKeyFile?: string;
}

/** A saved connection. Secrets are never persisted in this object. */
export interface ConnectionConfig {
  id: string;
  name: string;
  color?: string;
  /** 'uri' uses `uri` verbatim; 'fields' builds the URI from host/port/etc. */
  mode: 'uri' | 'fields';
  uri?: string;
  hosts?: string[];
  srv?: boolean;
  replicaSet?: string;
  directConnection?: boolean;
  defaultDatabase?: string;
  authDatabase?: string;
  username?: string;
  authMechanism?: AuthMechanism;
  readPreference?: ReadPreference;
  tls?: TlsConfig;
  connectTimeoutMs?: number;
  serverSelectionTimeoutMs?: number;
  /** Whether the password is kept in the encrypted secret store. */
  savePassword?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ConnectionSecrets {
  password?: string;
  tlsKeyPassword?: string;
}

export interface ActiveConnectionInfo {
  connectionId: string;
  name: string;
  uriSafe: string;
  topology: string;
  serverVersion: string;
  connectedAt: string;
}

export interface DatabaseSummary {
  name: string;
  sizeOnDisk: number;
  empty: boolean;
}

export interface CollectionSummary {
  name: string;
  type: 'collection' | 'view' | 'timeseries';
  documentCount: number | null;
}

export interface IndexInfo {
  name: string;
  keys: Record<string, unknown>;
  unique: boolean;
  sparse: boolean;
  ttlSeconds: number | null;
  sizeBytes: number | null;
  usageCount: number | null;
  since: string | null;
}

export interface CollectionStats {
  ns: string;
  documentCount: number;
  avgObjectSizeBytes: number;
  dataSizeBytes: number;
  storageSizeBytes: number;
  totalIndexSizeBytes: number;
  indexCount: number;
  capped: boolean;
  shardKey: Record<string, unknown> | null;
  indexes: IndexInfo[];
  /** Union of top-level field names sampled from the collection. */
  sampledFields: Array<{ field: string; types: string[]; presencePercent: number }>;
}

export interface DatabaseStats {
  name: string;
  collectionCount: number;
  viewCount: number;
  objectCount: number;
  avgObjectSizeBytes: number;
  dataSizeBytes: number;
  storageSizeBytes: number;
  indexCount: number;
  indexSizeBytes: number;
  fsUsedSizeBytes: number | null;
  fsTotalSizeBytes: number | null;
  collections: Array<{
    name: string;
    documentCount: number;
    dataSizeBytes: number;
    storageSizeBytes: number;
    indexSizeBytes: number;
    indexCount: number;
  }>;
}

export interface ServerInfo {
  version: string;
  gitVersion: string | null;
  topology: string;
  host: string | null;
  process: string | null;
  uptimeSeconds: number | null;
  currentConnections: number | null;
  availableConnections: number | null;
  storageEngine: string | null;
  maxBsonObjectSize: number | null;
  readOnly: boolean;
  modules: string[];
}

export type QueryResultKind = 'documents' | 'value' | 'acknowledgement' | 'empty';

export interface QueryResult {
  kind: QueryResultKind;
  /** Relaxed-EJSON documents, safe to structured-clone. */
  documents: unknown[];
  /** Present when `kind` is 'value' or 'acknowledgement'. */
  value?: unknown;
  columns: string[];
  totalReturned: number;
  truncated: boolean;
  durationMs: number;
  database: string;
  collection: string | null;
  operation: string | null;
  explain?: unknown;
}

export interface QueryRequest {
  connectionId: string;
  database: string;
  code: string;
  limit?: number;
  /** When set, wraps the query in an explain with the given verbosity. */
  explain?: 'queryPlanner' | 'executionStats' | 'allPlansExecution' | null;
}

export type ExportFormat = 'json-array' | 'ndjson' | 'csv';
export type ImportFormat = 'json-array' | 'ndjson' | 'csv' | 'auto';

export interface ExportRequest {
  connectionId: string;
  database: string;
  collection: string;
  format: ExportFormat;
  filePath: string;
  /** Optional EJSON/JS filter, e.g. `{ status: "active" }`. */
  filter?: string;
  projection?: string;
  sort?: string;
  limit?: number;
  skip?: number;
  /** CSV only; when empty the columns are derived from the first batch. */
  fields?: string[];
  jsonMode?: 'relaxed' | 'canonical';
  prettyPrint?: boolean;
}

export type ImportMode = 'insert' | 'upsert' | 'replace';

export interface ImportRequest {
  connectionId: string;
  database: string;
  collection: string;
  format: ImportFormat;
  filePath: string;
  mode: ImportMode;
  /** Fields forming the match key for 'upsert'/'replace'. */
  upsertFields?: string[];
  dropBeforeImport?: boolean;
  stopOnError?: boolean;
  batchSize?: number;
  /** CSV only. */
  csvDelimiter?: string;
  csvHasHeader?: boolean;
  /** CSV only: try to coerce numbers/booleans/dates instead of keeping strings. */
  csvInferTypes?: boolean;
}

export interface TransferProgress {
  jobId: string;
  kind: 'export' | 'import' | 'tool';
  phase: 'starting' | 'running' | 'done' | 'error' | 'cancelled';
  processed: number;
  total: number | null;
  bytes?: number;
  message?: string;
  filePath?: string;
  errors?: string[];
}

export interface TransferResult {
  jobId: string;
  ok: boolean;
  processed: number;
  failed: number;
  filePath: string;
  durationMs: number;
  errors: string[];
}

/** Paths to the official MongoDB Database Tools, resolved lazily and optional. */
export interface MongoToolPaths {
  mongodump: string;
  mongorestore: string;
  mongoexport: string;
  mongoimport: string;
  mongosh: string;
}

export type MongoToolName = keyof MongoToolPaths;

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  defaultQueryLimit: number;
  maxDocumentsInTable: number;
  useMongoTools: boolean;
  toolPaths: MongoToolPaths;
  autoConnectLastUsed: boolean;
  confirmDestructiveOps: boolean;
  csvDelimiter: string;
}

export interface ToolRunRequest {
  connectionId: string;
  tool: MongoToolName;
  database?: string;
  collection?: string;
  /** Target directory (dump/restore) or file (export/import). */
  target: string;
  extraArgs?: string[];
  /** For mongorestore/mongoimport. */
  drop?: boolean;
  /** mongoexport/mongoimport only. */
  format?: 'json' | 'csv';
  fields?: string[];
  /** mongodump only. */
  gzip?: boolean;
  query?: string;
}

export interface ToolDetection {
  tool: MongoToolName;
  path: string | null;
  version: string | null;
  source: 'setting' | 'path' | 'common-location' | null;
  ok: boolean;
  error?: string;
}

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  error: {
    message: string;
    code?: string | number;
    detail?: string;
  };
}

export type Result<T> = Ok<T> | Err;

/** The API surface exposed on `window.api` by the preload script. */
export interface RendererApi {
  connections: {
    list(): Promise<Result<ConnectionConfig[]>>;
    save(
      config: Partial<ConnectionConfig> & { name: string },
      secrets?: ConnectionSecrets
    ): Promise<Result<ConnectionConfig>>;
    remove(id: string): Promise<Result<null>>;
    duplicate(id: string): Promise<Result<ConnectionConfig>>;
    test(id: string, secrets?: ConnectionSecrets): Promise<Result<ServerInfo>>;
    testDraft(
      config: Partial<ConnectionConfig>,
      secrets?: ConnectionSecrets
    ): Promise<Result<ServerInfo>>;
    connect(id: string, secrets?: ConnectionSecrets): Promise<Result<ActiveConnectionInfo>>;
    disconnect(id: string): Promise<Result<null>>;
    active(): Promise<Result<ActiveConnectionInfo[]>>;
    hasSavedPassword(id: string): Promise<Result<boolean>>;
    exportAll(filePath: string): Promise<Result<{ count: number }>>;
    importAll(filePath: string): Promise<Result<{ count: number }>>;
  };
  data: {
    listDatabases(connectionId: string): Promise<Result<DatabaseSummary[]>>;
    listCollections(connectionId: string, database: string): Promise<Result<CollectionSummary[]>>;
    databaseStats(connectionId: string, database: string): Promise<Result<DatabaseStats>>;
    collectionStats(
      connectionId: string,
      database: string,
      collection: string
    ): Promise<Result<CollectionStats>>;
    serverInfo(connectionId: string): Promise<Result<ServerInfo>>;
    indexes(
      connectionId: string,
      database: string,
      collection: string
    ): Promise<Result<IndexInfo[]>>;
    createCollection(
      connectionId: string,
      database: string,
      collection: string
    ): Promise<Result<null>>;
    dropCollection(
      connectionId: string,
      database: string,
      collection: string
    ): Promise<Result<null>>;
    dropDatabase(connectionId: string, database: string): Promise<Result<null>>;
  };
  query: {
    run(request: QueryRequest): Promise<Result<QueryResult>>;
  };
  transfer: {
    exportCollection(request: ExportRequest): Promise<Result<TransferResult>>;
    importCollection(request: ImportRequest): Promise<Result<TransferResult>>;
    cancel(jobId: string): Promise<Result<null>>;
    onProgress(handler: (progress: TransferProgress) => void): () => void;
  };
  tools: {
    detect(): Promise<Result<ToolDetection[]>>;
    run(request: ToolRunRequest): Promise<Result<TransferResult>>;
  };
  settings: {
    get(): Promise<Result<AppSettings>>;
    update(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
  };
  dialog: {
    openFile(options?: {
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<Result<string | null>>;
    openDirectory(options?: { title?: string }): Promise<Result<string | null>>;
    saveFile(options?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<Result<string | null>>;
  };
  app: {
    version(): Promise<Result<{ app: string; electron: string; node: string; driver: string }>>;
    openExternal(url: string): Promise<Result<null>>;
    /** Fires when File ▸ New Query Tab is chosen. Returns an unsubscribe function. */
    onNewTab(handler: () => void): () => void;
  };
}
