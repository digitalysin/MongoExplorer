import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueryResult } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { formatDuration, formatNumber } from '../lib/format';
import { useStore } from '../state/store';
import { QueryEditor } from './QueryEditor';
import { ResultView, type ResultMode } from './ResultView';
import { Badge, Button, EmptyState, Select, Spinner } from './ui';

export interface QueryTabState {
  id: string;
  kind: 'query';
  title: string;
  connectionId: string;
  database: string;
  collection: string | null;
  code: string;
  limit: number;
  result: QueryResult | null;
  error: string | null;
  running: boolean;
}

export function QueryWorkspace({
  tab,
  onPatch
}: {
  tab: QueryTabState;
  onPatch: (patch: Partial<QueryTabState>) => void;
}) {
  const store = useStore();
  const [mode, setMode] = useState<ResultMode>('table');
  const [editorHeight, setEditorHeight] = useState(180);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);
  const databases = store.databases[tab.connectionId] ?? [];

  const run = useCallback(
    async (explain: 'executionStats' | null = null) => {
      onPatch({ running: true, error: null });
      try {
        const result = await unwrap(
          api.query.run({
            connectionId: tab.connectionId,
            database: tab.database,
            code: tab.code,
            limit: tab.limit,
            explain
          })
        );
        onPatch({ result, running: false, error: null });
        if (explain) setMode('json');
      } catch (error) {
        onPatch({ running: false, error: errorMessage(error), result: null });
      }
    },
    [onPatch, tab.code, tab.connectionId, tab.database, tab.limit]
  );

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!dragState.current) return;
      const delta = event.clientY - dragState.current.startY;
      setEditorHeight(Math.min(Math.max(dragState.current.startHeight + delta, 90), 600));
    };
    const onMouseUp = () => {
      dragState.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const dark = (document.documentElement.dataset.theme ?? 'dark') === 'dark';

  return (
    <div className="workspace">
      <div className="toolbar">
        <Select
          value={tab.database}
          style={{ width: 200 }}
          onChange={(event) => onPatch({ database: event.target.value })}
        >
          {databases.length === 0 ? <option value={tab.database}>{tab.database}</option> : null}
          {databases.map((database) => (
            <option key={database.name} value={database.name}>
              {database.name}
            </option>
          ))}
        </Select>

        <Button variant="primary" onClick={() => void run()} disabled={tab.running}>
          {tab.running ? <Spinner label="Running…" /> : '▶ Run'}
          <span className="faint" style={{ fontSize: 11 }}>
            ⌘⏎
          </span>
        </Button>

        <Button onClick={() => void run('executionStats')} disabled={tab.running} title="Explain">
          Explain
        </Button>

        <label className="row faint" style={{ gap: 6 }}>
          Limit
          <input
            className="input"
            style={{ width: 84 }}
            type="number"
            min={1}
            value={tab.limit}
            onChange={(event) => onPatch({ limit: Number(event.target.value) || 1 })}
          />
        </label>

        <span className="spacer" />

        <div className="segmented">
          <button
            type="button"
            className={mode === 'table' ? 'is-active' : ''}
            onClick={() => setMode('table')}
          >
            Table
          </button>
          <button
            type="button"
            className={mode === 'json' ? 'is-active' : ''}
            onClick={() => setMode('json')}
          >
            JSON
          </button>
        </div>
      </div>

      <QueryEditor
        value={tab.code}
        onChange={(code) => onPatch({ code })}
        onRun={() => void run()}
        height={editorHeight}
        dark={dark}
      />

      <div
        className="resize-handle"
        onMouseDown={(event) =>
          (dragState.current = { startY: event.clientY, startHeight: editorHeight })
        }
      />

      <div className="result-pane">
        <div className="result-bar">
          {tab.result ? (
            <>
              <span>
                <strong>{formatNumber(tab.result.totalReturned)}</strong> document
                {tab.result.totalReturned === 1 ? '' : 's'}
              </span>
              <span>{formatDuration(tab.result.durationMs)}</span>
              {tab.result.collection ? (
                <span className="mono faint">
                  {tab.result.database}.{tab.result.collection}
                </span>
              ) : null}
              {tab.result.truncated ? (
                <Badge tone="amber">Truncated at the limit — raise it to see more</Badge>
              ) : null}
              {tab.result.explain ? <Badge tone="blue">Explain plan</Badge> : null}
            </>
          ) : (
            <span className="faint">
              Write a query such as <span className="inline-code">db.users.find(&#123;&#125;)</span>{' '}
              and press ⌘/Ctrl + Enter.
            </span>
          )}
        </div>

        <div className="result-body">
          {tab.error ? <div className="error-box">{tab.error}</div> : null}
          {!tab.error && tab.result ? <ResultView result={tab.result} mode={mode} /> : null}
          {!tab.error && !tab.result ? (
            <EmptyState
              title="Nothing has run yet"
              description={
                <>
                  Anything mongosh understands works here: <code>find</code>, <code>aggregate</code>,{' '}
                  <code>countDocuments</code>, <code>updateMany</code>, and helpers such as{' '}
                  <code>ObjectId()</code> and <code>ISODate()</code>. Multi-statement scripts should
                  end with a <code>return</code>.
                </>
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
