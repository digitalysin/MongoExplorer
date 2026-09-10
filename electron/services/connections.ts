import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { MongoClientOptions } from 'mongodb';
import type { ConnectionConfig, ConnectionSecrets } from '../../shared/types.js';
import {
  deleteSecrets,
  getSecrets,
  hasSecrets,
  loadConnections,
  saveConnections,
  setSecrets
} from './store.js';

const DEFAULT_HOST = 'localhost:27017';

export function listConnections(): ConnectionConfig[] {
  return loadConnections().sort((a, b) => a.name.localeCompare(b.name));
}

export function getConnection(id: string): ConnectionConfig {
  const found = loadConnections().find((c) => c.id === id);
  if (!found) throw new Error(`Connection "${id}" was not found.`);
  return found;
}

function normalize(config: Partial<ConnectionConfig>): Partial<ConnectionConfig> {
  const hosts = (config.hosts ?? [])
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return {
    ...config,
    name: config.name?.trim(),
    uri: config.uri?.trim(),
    hosts: hosts.length > 0 ? hosts : undefined,
    username: config.username?.trim() || undefined,
    defaultDatabase: config.defaultDatabase?.trim() || undefined,
    authDatabase: config.authDatabase?.trim() || undefined,
    replicaSet: config.replicaSet?.trim() || undefined
  };
}

export function upsertConnection(
  input: Partial<ConnectionConfig> & { name: string },
  secrets?: ConnectionSecrets
): ConnectionConfig {
  const connections = loadConnections();
  const now = new Date().toISOString();
  const patch = normalize(input);
  const existingIndex = patch.id ? connections.findIndex((c) => c.id === patch.id) : -1;

  const base: ConnectionConfig =
    existingIndex >= 0
      ? connections[existingIndex]
      : {
          id: randomUUID(),
          name: patch.name ?? 'New connection',
          mode: 'uri',
          createdAt: now,
          updatedAt: now
        };

  const merged: ConnectionConfig = {
    ...base,
    ...patch,
    id: base.id,
    name: patch.name || base.name,
    createdAt: base.createdAt,
    updatedAt: now
  };

  if (merged.mode === 'fields' && (!merged.hosts || merged.hosts.length === 0)) {
    merged.hosts = [DEFAULT_HOST];
  }
  if (merged.mode === 'uri' && !merged.uri) {
    throw new Error('A connection string is required when using URI mode.');
  }
  // Validate before persisting so a broken config never lands in the store.
  buildConnectionUri(merged, {});

  if (existingIndex >= 0) connections[existingIndex] = merged;
  else connections.push(merged);
  saveConnections(connections);

  if (secrets && Object.keys(secrets).length > 0) {
    if (merged.savePassword) setSecrets(merged.id, secrets);
  }
  if (!merged.savePassword) deleteSecrets(merged.id);

  return merged;
}

export function removeConnection(id: string): void {
  saveConnections(loadConnections().filter((c) => c.id !== id));
  deleteSecrets(id);
}

export function duplicateConnection(id: string): ConnectionConfig {
  const source = getConnection(id);
  const now = new Date().toISOString();
  const copy: ConnectionConfig = {
    ...source,
    id: randomUUID(),
    name: `${source.name} (copy)`,
    savePassword: false,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: undefined
  };
  saveConnections([...loadConnections(), copy]);
  return copy;
}

export function markUsed(id: string): void {
  const connections = loadConnections();
  const index = connections.findIndex((c) => c.id === id);
  if (index < 0) return;
  connections[index] = { ...connections[index], lastUsedAt: new Date().toISOString() };
  saveConnections(connections);
}

export function connectionHasSavedPassword(id: string): boolean {
  return hasSecrets(id);
}

/** Secrets typed in the connect dialog win over the stored ones. */
export function resolveSecrets(id: string, provided?: ConnectionSecrets): ConnectionSecrets {
  const stored = getSecrets(id);
  return { ...stored, ...stripEmpty(provided ?? {}) };
}

function stripEmpty(secrets: ConnectionSecrets): ConnectionSecrets {
  const out: ConnectionSecrets = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.length > 0) {
      out[key as keyof ConnectionSecrets] = value;
    }
  }
  return out;
}

function appendQueryParams(uri: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== '');
  if (entries.length === 0) return uri;
  const query = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return uri.includes('?') ? `${uri}&${query}` : `${uri}?${query}`;
}

/**
 * Builds the connection string. In field mode the URI is assembled from the
 * individual settings; in URI mode the stored string is used as-is and only the
 * password is injected when the user supplied one separately.
 */
export function buildConnectionUri(
  config: Partial<ConnectionConfig>,
  secrets: ConnectionSecrets,
  options: { redactPassword?: boolean; embedPassword?: boolean } = {}
): string {
  const password = secrets.password ?? '';
  const shownPassword = options.redactPassword ? '*****' : encodeURIComponent(password);

  if (config.mode !== 'fields') {
    const raw = (config.uri ?? '').trim();
    if (!raw) throw new Error('A connection string is required.');
    if (!/^mongodb(\+srv)?:\/\//i.test(raw)) {
      throw new Error('Connection string must start with "mongodb://" or "mongodb+srv://".');
    }
    if (!password) return raw;
    // Inject the password only when the URI carries a username without one.
    return raw.replace(
      /^(mongodb(?:\+srv)?:\/\/)([^/@:]+)(@)/i,
      (_match, scheme: string, user: string, at: string) => `${scheme}${user}:${shownPassword}${at}`
    );
  }

  const scheme = config.srv ? 'mongodb+srv://' : 'mongodb://';
  const hosts = (config.hosts?.length ? config.hosts : [DEFAULT_HOST])
    // mongodb+srv resolves the port from DNS and rejects an explicit one.
    .map((host) => (config.srv ? host.replace(/:\d+$/, '') : host))
    .join(',');
  // In field mode the password normally travels through MongoClientOptions.auth
  // rather than the URI. External tools only accept a connection string, so
  // they ask for it to be embedded explicitly.
  const embedded = (options.embedPassword || options.redactPassword) && password;
  const credentials = config.username
    ? `${encodeURIComponent(config.username)}${embedded ? `:${shownPassword}` : ''}@`
    : '';
  const authSource = config.authDatabase || (config.username ? 'admin' : '');
  const pathDb = config.defaultDatabase ? `/${encodeURIComponent(config.defaultDatabase)}` : '/';

  let uri = `${scheme}${credentials}${hosts}${pathDb}`;
  const params: Record<string, string> = {};
  if (authSource) params.authSource = authSource;
  if (config.replicaSet) params.replicaSet = config.replicaSet;
  if (config.directConnection) params.directConnection = 'true';
  if (config.readPreference && config.readPreference !== 'primary') {
    params.readPreference = config.readPreference;
  }
  if (config.authMechanism && config.authMechanism !== 'DEFAULT') {
    params.authMechanism = config.authMechanism;
  }
  if (config.tls?.enabled) params.tls = 'true';
  uri = appendQueryParams(uri, params);
  return uri;
}

/** A display-safe URI: never contains the password. */
export function describeConnection(config: ConnectionConfig): string {
  try {
    return buildConnectionUri(config, { password: 'x' }, { redactPassword: true });
  } catch {
    return config.uri ?? '(invalid configuration)';
  }
}

export function buildClientOptions(
  config: Partial<ConnectionConfig>,
  secrets: ConnectionSecrets
): MongoClientOptions {
  const options: MongoClientOptions = {
    appName: 'Mongo Explorer',
    connectTimeoutMS: config.connectTimeoutMs ?? 10_000,
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMs ?? 10_000,
    maxPoolSize: 10,
    retryWrites: true
  };

  const tls = config.tls;
  if (tls?.enabled) {
    options.tls = true;
    if (tls.allowInvalidCertificates) options.tlsAllowInvalidCertificates = true;
    if (tls.allowInvalidHostnames) options.tlsAllowInvalidHostnames = true;
    if (tls.caFile) {
      assertReadable(tls.caFile, 'TLS CA file');
      options.tlsCAFile = tls.caFile;
    }
    if (tls.certificateKeyFile) {
      assertReadable(tls.certificateKeyFile, 'TLS certificate key file');
      options.tlsCertificateKeyFile = tls.certificateKeyFile;
    }
    if (secrets.tlsKeyPassword) options.tlsCertificateKeyFilePassword = secrets.tlsKeyPassword;
  }

  // In URI mode the credentials already live in the string.
  if (config.mode === 'fields' && config.username && secrets.password) {
    options.auth = { username: config.username, password: secrets.password };
    options.authSource = config.authDatabase || 'admin';
    if (config.authMechanism && config.authMechanism !== 'DEFAULT') {
      options.authMechanism = config.authMechanism;
    }
  }
  return options;
}

function assertReadable(file: string, label: string): void {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
}
