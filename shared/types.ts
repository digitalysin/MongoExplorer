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

/** How much ceremony a connection's writes deserve. */
export type ConnectionEnvironment = 'development' | 'staging' | 'production';

/** A saved connection. Secrets are never persisted in this object. */
export interface ConnectionConfig {
  id: string;
  name: string;
  color?: string;
  /** Production connections ask for the name of whatever is about to be dropped. */
  environment?: ConnectionEnvironment;
  /** Refuses every write, in the main process rather than only in the UI. */
  readOnly?: boolean;
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

/** One operation the deployment is running right now. */
export interface RunningOperation {
  opid: string;
  active: boolean;
  secondsRunning: number | null;
  op: string | null;
  namespace: string | null;
  /** A one-line version of the command document. */
  command: string | null;
  planSummary: string | null;
  client: string | null;
  appName: string | null;
  waitingForLock: boolean;
  description: string | null;
}

/** One operation the profiler recorded as slow. */
export interface SlowOperation {
  at: string;
  millis: number;
  op: string | null;
  namespace: string | null;
  planSummary: string | null;
  command: string | null;
  documentsExamined: number | null;
  keysExamined: number | null;
  returned: number | null;
}

export interface ProfilerSnapshot {
  database: string;
  /** 0 off, 1 slow operations only, 2 everything. */
  level: number;
  slowMs: number;
  operations: SlowOperation[];
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
  /** What a dry run found the writes in the query would have done. */
  preview?: QueryWritePreview[];
}

/** One write a query would perform, measured without performing it. */
export interface QueryWritePreview {
  method: string;
  namespace: string;
  /** Documents the operation would change; null when that cannot be counted. */
  affected: number | null;
  note?: string;
}

export interface QueryRequest {
  connectionId: string;
  database: string;
  code: string;
  limit?: number;
  /** Documents to skip before the page, for paging through a cursor. */
  skip?: number;
  /** When set, wraps the query in an explain with the given verbosity. */
  explain?: 'queryPlanner' | 'executionStats' | 'allPlansExecution' | null;
  /**
   * Runs the reads but counts the writes instead of performing them, so the
   * user can be told what a query would change before it changes it.
   */
  dryRun?: boolean;
}

export interface CreateIndexRequest {
  connectionId: string;
  database: string;
  collection: string;
  /** Index keys as a JS/EJSON expression, e.g. `{ status: 1, createdAt: -1 }`. */
  keys: string;
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  /** TTL in seconds; only valid on a single-field date index. */
  expireAfterSeconds?: number | null;
  /** Partial filter expression, e.g. `{ archived: false }`. */
  partialFilter?: string;
  collation?: string;
}

export interface DocumentRef {
  connectionId: string;
  database: string;
  collection: string;
  /** Canonical EJSON of the document's `_id`. */
  idJson: string;
}

/** Several documents in one collection, addressed by their `_id`s. */
export interface BulkDocumentsRequest {
  connectionId: string;
  database: string;
  collection: string;
  /** Canonical EJSON of each document's `_id`. */
  idsJson: string[];
}

export interface BulkFieldRequest extends BulkDocumentsRequest {
  field: string;
  /** Canonical EJSON of the value to write. */
  valueJson: string;
}

export interface BulkWriteResult {
  matched: number;
  modified: number;
  /** What each document now stores, as relaxed EJSON, for repainting the table. */
  updates: Array<{ idJson: string; value: unknown }>;
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  code: string;
  at: string;
  durationMs: number;
  ok: boolean;
  totalReturned: number;
  error?: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  code: string;
  database: string;
  connectionId?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * Several collections, or a whole database, in one job. The files land in a
 * directory named after the database, one per collection.
 */
export interface ExportManyRequest {
  connectionId: string;
  database: string;
  /** Empty means every collection in the database. */
  collections: string[];
  format: ExportFormat;
  /** Parent directory; the database gets a folder of its own inside it. */
  directory: string;
  /** Applied to every collection, so it only makes sense on shared fields. */
  filter?: string;
  /** Per collection, for sampling a database. */
  limit?: number;
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
  /** Bytes written (export) or read (import) so far. */
  bytes?: number;
  /** Bytes in the source, when known — the only usable share for an import. */
  totalBytes?: number;
  /** When the job began, so the UI can run its own clock and estimate. */
  startedAt: string;
  message?: string;
  filePath?: string;
  errors?: string[];
}

/** One collection of a batch export. */
export interface TransferPart {
  collection: string;
  processed: number;
  filePath: string;
  /** Set when this collection failed and the rest of the batch carried on. */
  error?: string;
}

export interface TransferResult {
  jobId: string;
  ok: boolean;
  processed: number;
  failed: number;
  filePath: string;
  durationMs: number;
  errors: string[];
  /** One entry per collection, for a batch export. */
  parts?: TransferPart[];
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
    /** Tests the values on screen; pass the id of a saved connection to reuse its stored password. */
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
    /** Creates `database` by creating its first collection — Mongo has no standalone create. */
    createDatabase(
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
    createIndex(request: CreateIndexRequest): Promise<Result<{ name: string }>>;
    dropIndex(
      connectionId: string,
      database: string,
      collection: string,
      indexName: string
    ): Promise<Result<null>>;
    /** Canonical EJSON of one document, for lossless editing. */
    getDocument(ref: DocumentRef): Promise<Result<string>>;
    replaceDocument(ref: DocumentRef, documentJson: string): Promise<Result<null>>;
    insertDocument(
      connectionId: string,
      database: string,
      collection: string,
      documentJson: string
    ): Promise<Result<{ insertedId: unknown }>>;
    deleteDocument(ref: DocumentRef): Promise<Result<null>>;
    /**
     * Writes one field with `$set` — the write behind in-place table editing.
     * `valueJson` is canonical EJSON; the stored value comes back as relaxed
     * EJSON so the table can repaint a single cell.
     */
    setDocumentField(
      ref: DocumentRef,
      field: string,
      valueJson: string
    ): Promise<Result<{ value: unknown }>>;
    /** Removes one field with `$unset`. */
    unsetDocumentField(ref: DocumentRef, field: string): Promise<Result<null>>;
    /** The same `$set`, across a selection of documents. */
    setFieldOnMany(request: BulkFieldRequest): Promise<Result<BulkWriteResult>>;
    unsetFieldOnMany(
      request: BulkDocumentsRequest & { field: string }
    ): Promise<Result<{ matched: number; modified: number }>>;
    deleteDocuments(request: BulkDocumentsRequest): Promise<Result<{ deleted: number }>>;
    /** Inserts a copy of the document under a fresh `_id`. */
    duplicateDocument(ref: DocumentRef): Promise<Result<{ insertedId: unknown }>>;
  };
  query: {
    run(request: QueryRequest): Promise<Result<QueryResult>>;
  };
  ops: {
    current(
      connectionId: string,
      options?: { includeIdle?: boolean }
    ): Promise<Result<RunningOperation[]>>;
    kill(connectionId: string, opid: string): Promise<Result<null>>;
    profiler(
      connectionId: string,
      database: string,
      limit?: number
    ): Promise<Result<ProfilerSnapshot>>;
  };
  library: {
    history(limit?: number): Promise<Result<QueryHistoryEntry[]>>;
    clearHistory(): Promise<Result<null>>;
    savedQueries(): Promise<Result<SavedQuery[]>>;
    saveQuery(
      query: Partial<SavedQuery> & { name: string; code: string }
    ): Promise<Result<SavedQuery>>;
    removeSavedQuery(id: string): Promise<Result<null>>;
  };
  transfer: {
    exportCollection(request: ExportRequest): Promise<Result<TransferResult>>;
    /** Several collections, or a whole database, as one job. */
    exportCollections(request: ExportManyRequest): Promise<Result<TransferResult>>;
    /** What a whole-database export would cover. */
    exportableCollections(connectionId: string, database: string): Promise<Result<string[]>>;
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
    copyToClipboard(text: string): Promise<Result<null>>;
    /** Fires when File ▸ New Query Tab is chosen. Returns an unsubscribe function. */
    onNewTab(handler: () => void): () => void;
  };
}
