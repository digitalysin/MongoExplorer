import { randomUUID } from 'node:crypto';
import type { QueryHistoryEntry, SavedQuery } from '../../shared/types.js';
import { readStoreFile, writeStoreFile } from './store.js';

const HISTORY_FILE = 'history.json';
const SAVED_FILE = 'saved-queries.json';
const HISTORY_LIMIT = 300;

export function listHistory(limit = 100): QueryHistoryEntry[] {
  return readStoreFile<QueryHistoryEntry[]>(HISTORY_FILE, []).slice(0, Math.max(limit, 1));
}

/** Consecutive identical runs collapse into one entry so the list stays useful. */
export function recordHistory(entry: Omit<QueryHistoryEntry, 'id' | 'at'>): void {
  const history = readStoreFile<QueryHistoryEntry[]>(HISTORY_FILE, []);
  const previous = history[0];
  const isRepeat =
    previous &&
    previous.code === entry.code &&
    previous.database === entry.database &&
    previous.connectionId === entry.connectionId;

  const record: QueryHistoryEntry = { ...entry, id: randomUUID(), at: new Date().toISOString() };
  const next = isRepeat ? [record, ...history.slice(1)] : [record, ...history];
  writeStoreFile(HISTORY_FILE, next.slice(0, HISTORY_LIMIT));
}

export function clearHistory(): void {
  writeStoreFile(HISTORY_FILE, []);
}

export function listSavedQueries(): SavedQuery[] {
  return readStoreFile<SavedQuery[]>(SAVED_FILE, []).sort((a, b) => a.name.localeCompare(b.name));
}

export function saveQuery(input: Partial<SavedQuery> & { name: string; code: string }): SavedQuery {
  const name = input.name.trim();
  if (!name) throw new Error('Give the query a name.');
  if (!input.code.trim()) throw new Error('There is nothing to save — the editor is empty.');

  const saved = readStoreFile<SavedQuery[]>(SAVED_FILE, []);
  const now = new Date().toISOString();
  const existingIndex = input.id ? saved.findIndex((entry) => entry.id === input.id) : -1;
  const base = existingIndex >= 0 ? saved[existingIndex] : null;

  const record: SavedQuery = {
    id: base?.id ?? randomUUID(),
    name,
    code: input.code,
    database: input.database ?? base?.database ?? '',
    connectionId: input.connectionId ?? base?.connectionId,
    description: input.description ?? base?.description,
    createdAt: base?.createdAt ?? now,
    updatedAt: now
  };

  if (existingIndex >= 0) saved[existingIndex] = record;
  else saved.push(record);
  writeStoreFile(SAVED_FILE, saved);
  return record;
}

export function removeSavedQuery(id: string): void {
  writeStoreFile(
    SAVED_FILE,
    readStoreFile<SavedQuery[]>(SAVED_FILE, []).filter((entry) => entry.id !== id)
  );
}
