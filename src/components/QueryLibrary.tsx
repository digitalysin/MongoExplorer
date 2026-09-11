import { useCallback, useEffect, useState } from 'react';
import type { QueryHistoryEntry, SavedQuery } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { formatDuration, formatNumber } from '../lib/format';
import { useStore } from '../state/store';
import { Badge, Button, EmptyState, Modal, Spinner } from './ui';

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function QueryLibrary({
  onClose,
  onOpen
}: {
  onClose: () => void;
  /** Loads the chosen query into the active tab. */
  onOpen: (code: string, database: string | null) => void;
}) {
  const store = useStore();
  const [tab, setTab] = useState<'history' | 'saved'>('history');
  const [history, setHistory] = useState<QueryHistoryEntry[] | null>(null);
  const [saved, setSaved] = useState<SavedQuery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [historyEntries, savedEntries] = await Promise.all([
        unwrap(api.library.history(200)),
        unwrap(api.library.savedQueries())
      ]);
      setHistory(historyEntries);
      setSaved(savedEntries);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal
      title="Query library"
      onClose={onClose}
      width={820}
      footer={
        <>
          {tab === 'history' && history && history.length > 0 ? (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await unwrap(api.library.clearHistory());
                  store.notify('Cleared the query history');
                  await load();
                } catch (caught) {
                  store.reportError('Could not clear the query history', caught);
                }
              }}
            >
              Clear history
            </Button>
          ) : null}
          <span className="spacer" />
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="segmented" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={tab === 'history' ? 'is-active' : ''}
          onClick={() => setTab('history')}
        >
          History{history ? ` (${history.length})` : ''}
        </button>
        <button
          type="button"
          className={tab === 'saved' ? 'is-active' : ''}
          onClick={() => setTab('saved')}
        >
          Saved{saved ? ` (${saved.length})` : ''}
        </button>
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      {tab === 'history' ? (
        history === null ? (
          <Spinner label="Loading…" />
        ) : history.length === 0 ? (
          <EmptyState
            title="No queries yet"
            description="Every query you run is recorded here, successful or not."
          />
        ) : (
          <div className="stack">
            {history.map((entry) => (
              <div key={entry.id} className="library-entry">
                <div className="row" style={{ marginBottom: 4 }}>
                  {entry.ok ? (
                    <Badge tone="green">{formatNumber(entry.totalReturned)} docs</Badge>
                  ) : (
                    <Badge tone="red">failed</Badge>
                  )}
                  <span className="faint mono">
                    {entry.connectionName || 'unknown'} · {entry.database}
                  </span>
                  {entry.ok ? (
                    <span className="faint">{formatDuration(entry.durationMs)}</span>
                  ) : null}
                  <span className="spacer" />
                  <span className="faint">{relativeTime(entry.at)}</span>
                  <Button size="sm" onClick={() => onOpen(entry.code, entry.database)}>
                    Open
                  </Button>
                </div>
                <pre className="library-code">{entry.code}</pre>
                {entry.error ? (
                  <div className="faint mono" style={{ fontSize: 11.5 }}>
                    {entry.error}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )
      ) : saved === null ? (
        <Spinner label="Loading…" />
      ) : saved.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          description="Use “Save query” in the toolbar to keep a query around under a name."
        />
      ) : (
        <div className="stack">
          {saved.map((entry) => (
            <div key={entry.id} className="library-entry">
              <div className="row" style={{ marginBottom: 4 }}>
                <strong>{entry.name}</strong>
                {entry.database ? <span className="faint mono">{entry.database}</span> : null}
                <span className="spacer" />
                <span className="faint">{relativeTime(entry.updatedAt)}</span>
                <Button size="sm" onClick={() => onOpen(entry.code, entry.database || null)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Delete"
                  onClick={async () => {
                    try {
                      await unwrap(api.library.removeSavedQuery(entry.id));
                      store.notify(`Deleted “${entry.name}”`);
                      await load();
                    } catch (caught) {
                      store.reportError(`Could not delete “${entry.name}”`, caught);
                    }
                  }}
                >
                  🗑
                </Button>
              </div>
              <pre className="library-code">{entry.code}</pre>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function SaveQueryDialog({
  code,
  database,
  connectionId,
  onClose,
  onSaved
}: {
  code: string;
  database: string;
  connectionId: string;
  onClose: () => void;
  onSaved: (query: SavedQuery) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await unwrap(
        api.library.saveQuery({
          name,
          code,
          database,
          connectionId,
          description: description.trim() || undefined
        })
      );
      onSaved(saved);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Save query"
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          autoFocus
          value={name}
          placeholder="Paid orders from the last week"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">Description (optional)</span>
        <input
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <pre className="library-code">{code}</pre>
      {error ? <div className="error-box">{error}</div> : null}
    </Modal>
  );
}
