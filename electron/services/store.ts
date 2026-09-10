import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, ConnectionConfig, ConnectionSecrets } from '../../shared/types.js';

const CONNECTIONS_FILE = 'connections.json';
const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.dat';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  defaultQueryLimit: 200,
  maxDocumentsInTable: 2000,
  useMongoTools: false,
  toolPaths: {
    mongodump: '',
    mongorestore: '',
    mongoexport: '',
    mongoimport: '',
    mongosh: ''
  },
  autoConnectLastUsed: false,
  confirmDestructiveOps: true,
  csvDelimiter: ','
};

function dataDir(): string {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonFile<T>(file: string, fallback: T): T {
  const target = path.join(dataDir(), file);
  try {
    if (!fs.existsSync(target)) return fallback;
    return JSON.parse(fs.readFileSync(target, 'utf8')) as T;
  } catch {
    // A corrupted file must not brick startup; keep a copy and start clean.
    try {
      fs.renameSync(target, `${target}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  const target = path.join(dataDir(), file);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function loadConnections(): ConnectionConfig[] {
  const list = readJsonFile<ConnectionConfig[]>(CONNECTIONS_FILE, []);
  return Array.isArray(list) ? list : [];
}

export function saveConnections(connections: ConnectionConfig[]): void {
  writeJsonFile(CONNECTIONS_FILE, connections);
}

export function loadSettings(): AppSettings {
  const stored = readJsonFile<Partial<AppSettings>>(SETTINGS_FILE, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    toolPaths: { ...DEFAULT_SETTINGS.toolPaths, ...(stored.toolPaths ?? {}) }
  };
}

export function saveSettings(settings: AppSettings): void {
  writeJsonFile(SETTINGS_FILE, settings);
}

type SecretVault = Record<string, ConnectionSecrets>;

/**
 * Secrets live in a separate file encrypted with the OS keychain (Keychain on
 * macOS, DPAPI on Windows, libsecret on Linux). If encryption is unavailable we
 * refuse to persist rather than silently writing plaintext passwords to disk.
 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readVault(): SecretVault {
  const target = path.join(dataDir(), SECRETS_FILE);
  if (!fs.existsSync(target)) return {};
  try {
    const blob = fs.readFileSync(target);
    if (blob.length === 0) return {};
    const plaintext = safeStorage.decryptString(blob);
    return JSON.parse(plaintext) as SecretVault;
  } catch {
    return {};
  }
}

function writeVault(vault: SecretVault): void {
  const target = path.join(dataDir(), SECRETS_FILE);
  const blob = safeStorage.encryptString(JSON.stringify(vault));
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, blob, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function getSecrets(connectionId: string): ConnectionSecrets {
  if (!encryptionAvailable()) return {};
  return readVault()[connectionId] ?? {};
}

export function setSecrets(connectionId: string, secrets: ConnectionSecrets): void {
  if (!encryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable, so passwords cannot be saved. ' +
        'Disable "Save password" for this connection or install a keyring (libsecret) on Linux.'
    );
  }
  const vault = readVault();
  const merged = { ...(vault[connectionId] ?? {}), ...secrets };
  for (const key of Object.keys(merged) as Array<keyof ConnectionSecrets>) {
    if (!merged[key]) delete merged[key];
  }
  if (Object.keys(merged).length === 0) delete vault[connectionId];
  else vault[connectionId] = merged;
  writeVault(vault);
}

export function deleteSecrets(connectionId: string): void {
  if (!encryptionAvailable()) return;
  const vault = readVault();
  if (!(connectionId in vault)) return;
  delete vault[connectionId];
  writeVault(vault);
}

export function hasSecrets(connectionId: string): boolean {
  const secrets = getSecrets(connectionId);
  return Boolean(secrets.password || secrets.tlsKeyPassword);
}
