import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import type {
  ActiveConnectionInfo,
  ConnectionConfig,
  ConnectionSecrets,
  ServerInfo
} from '../../shared/types.js';
import {
  buildClientOptions,
  buildConnectionUri,
  describeConnection,
  getConnection,
  markUsed,
  resolveSecrets
} from './connections.js';

interface PooledConnection {
  client: MongoClient;
  info: ActiveConnectionInfo;
}

const pool = new Map<string, PooledConnection>();

export async function openClient(
  config: Partial<ConnectionConfig>,
  secrets: ConnectionSecrets
): Promise<MongoClient> {
  const uri = buildConnectionUri(config, secrets);
  const client = new MongoClient(uri, buildClientOptions(config, secrets));
  await client.connect();
  return client;
}

/** Connects and keeps the client around for subsequent queries. */
export async function connect(
  connectionId: string,
  provided?: ConnectionSecrets
): Promise<ActiveConnectionInfo> {
  const existing = pool.get(connectionId);
  if (existing) return existing.info;

  const config = getConnection(connectionId);
  const secrets = resolveSecrets(connectionId, provided);
  const client = await openClient(config, secrets);

  try {
    const serverInfo = await readServerInfo(client);
    const info: ActiveConnectionInfo = {
      connectionId,
      name: config.name,
      uriSafe: describeConnection(config),
      topology: serverInfo.topology,
      serverVersion: serverInfo.version,
      connectedAt: new Date().toISOString()
    };
    pool.set(connectionId, { client, info });
    markUsed(connectionId);
    return info;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function disconnect(connectionId: string): Promise<void> {
  const pooled = pool.get(connectionId);
  if (!pooled) return;
  pool.delete(connectionId);
  await pooled.client.close().catch(() => undefined);
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...pool.keys()].map((id) => disconnect(id)));
}

export function activeConnections(): ActiveConnectionInfo[] {
  return [...pool.values()].map((pooled) => pooled.info);
}

export function isConnected(connectionId: string): boolean {
  return pool.has(connectionId);
}

export function getClient(connectionId: string): MongoClient {
  const pooled = pool.get(connectionId);
  if (!pooled) {
    throw new Error('Not connected. Open the connection before running this operation.');
  }
  return pooled.client;
}

export function getDb(connectionId: string, database: string): Db {
  if (!database) throw new Error('No database selected.');
  return getClient(connectionId).db(database);
}

/** Probes a configuration without adding it to the pool. */
export async function testConnection(
  config: Partial<ConnectionConfig>,
  secrets: ConnectionSecrets
): Promise<ServerInfo> {
  const client = await openClient(config, secrets);
  try {
    return await readServerInfo(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function topologyLabel(client: MongoClient): string {
  const description = (client as unknown as { topology?: { description?: { type?: string } } })
    .topology?.description;
  const type = description?.type ?? 'Unknown';
  switch (type) {
    case 'ReplicaSetWithPrimary':
    case 'ReplicaSetNoPrimary':
      return 'Replica Set';
    case 'Sharded':
      return 'Sharded Cluster';
    case 'Single':
      return 'Standalone';
    case 'LoadBalanced':
      return 'Load Balanced';
    default:
      return type;
  }
}

export async function readServerInfo(client: MongoClient): Promise<ServerInfo> {
  const admin = client.db('admin');
  const buildInfo = (await admin.command({ buildInfo: 1 }).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  // serverStatus is unavailable to low-privilege users and on Atlas free tiers.
  const status = (await admin.command({ serverStatus: 1 }).catch(() => null)) as Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  > | null;
  const hello = (await admin.command({ hello: 1 }).catch(() => ({}))) as Record<string, unknown>;

  return {
    version: String(buildInfo.version ?? hello.version ?? 'unknown'),
    gitVersion: typeof buildInfo.gitVersion === 'string' ? buildInfo.gitVersion : null,
    topology: topologyLabel(client),
    host: status && typeof status.host === 'string' ? status.host : null,
    process: status && typeof status.process === 'string' ? status.process : null,
    uptimeSeconds: status && typeof status.uptime === 'number' ? Math.round(status.uptime) : null,
    currentConnections: status?.connections?.current ?? null,
    availableConnections: status?.connections?.available ?? null,
    storageEngine: status?.storageEngine?.name ?? null,
    maxBsonObjectSize:
      typeof hello.maxBsonObjectSize === 'number' ? (hello.maxBsonObjectSize as number) : null,
    readOnly: hello.readOnly === true,
    modules: Array.isArray(buildInfo.modules) ? (buildInfo.modules as string[]) : []
  };
}

export async function serverInfoFor(connectionId: string): Promise<ServerInfo> {
  return readServerInfo(getClient(connectionId));
}
