import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueryResult, QueryWritePreview } from '../../shared/types';
import { detectWrites, type DetectedWrite } from '../../shared/writeOps';
import { api, errorMessage, unwrap } from '../lib/api';
import { formatDuration, formatNumber } from '../lib/format';
import { useStore } from '../state/store';
import { DocumentEditor, type DocumentEditorTarget } from './DocumentEditor';
import { QueryEditor } from './QueryEditor';
import { QueryLibrary, SaveQueryDialog } from './QueryLibrary';
import { ResultView, type ResultMode } from './ResultView';
import { WriteGuardDialog } from './WriteGuardDialog';
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
  /** Which page of results is on screen; 0 is the first. */
  page: number;
  result: QueryResult | null;
  error: string | null;
  running: boolean;
}

interface PendingWrite {
  code: string;
  explain: 'executionStats' | null;
  writes: DetectedWrite[];
  preview: QueryWritePreview[] | null;
  checking: boolean;
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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [editing, setEditing] = useState<DocumentEditorTarget | null>(null);
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);
  const databases = store.databases[tab.connectionId] ?? [];
  const connection = store.connections.find((entry) => entry.id === tab.connectionId);
  const environment = connection?.environment ?? 'development';

  const execute = useCallback(
    async (code: string, explain: 'executionStats' | null, page = 0) => {
      onPatch({ running: true, error: null, page });
      try {
        const result = await unwrap(
          api.query.run({
            connectionId: tab.connectionId,
            database: tab.database,
            code,
            limit: tab.limit,
            skip: page * tab.limit,
            explain
          })
        );
        onPatch({ result, running: false, error: null });
        if (explain) setMode('json');
      } catch (error) {
        onPatch({ running: false, error: errorMessage(error), result: null });
      }
    },
    [onPatch, tab.connectionId, tab.database, tab.limit]
  );

  /**
   * Paging re-runs the query with a larger skip. The rows are fetched rather
   * than held in memory, so a page costs one query and nothing else.
   */
  const goToPage = (page: number) => void execute(tab.code, null, Math.max(page, 0));

  /**
   * Nothing reaches the deployment through this function without the user
   * having been told what it would change — unless the query only reads, which
   * is the common case and stays as immediate as it was.
   */
  const run = useCallback(
    async (explain: 'executionStats' | null = null, code?: string) => {
      // A freshly written query runs before the patched tab state arrives.
      const source = code ?? tab.code;
      const writes = detectWrites(source);

      if (writes.length === 0) {
        await execute(source, explain);
        return;
      }

      if (connection?.readOnly) {
        store.reportError(
          `“${connection.name}” is read-only`,
          `The query calls ${writes
            .map((write) => write.method)
            .join(', ')}. Turn read-only off in the connection's settings if you meant to write to it.`
        );
        return;
      }

      if (store.settings?.confirmDestructiveOps === false) {
        await execute(source, explain);
        return;
      }

      setPendingWrite({ code: source, explain, writes, preview: null, checking: true });
      try {
        const dry = await unwrap(
          api.query.run({
            connectionId: tab.connectionId,
            database: tab.database,
            code: source,
            limit: tab.limit,
            explain,
            dryRun: true
          })
        );
        setPendingWrite((current) =>
          current && current.code === source
            ? { ...current, preview: dry.preview ?? [], checking: false }
            : current
        );
      } catch (error) {
        setPendingWrite(null);
        onPatch({ running: false, error: errorMessage(error), result: null });
      }
    },
    [connection, execute, onPatch, store, tab.code, tab.connectionId, tab.database, tab.limit]
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

  /**
   * In-place edits are confirmed by the server one field at a time, so the row
   * on screen is patched instead of re-running the whole query.
   */
  const patchRow = (rowIndex: number, field: string, value: unknown) => {
    const result = tab.result;
    if (!result) return;
    const documents = result.documents.map((document, index) => {
      if (index !== rowIndex) return document;
      const next = { ...(document as Record<string, unknown>) };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return next;
    });
    const columns = result.columns.includes(field) ? result.columns : [...result.columns, field];
    onPatch({ result: { ...result, documents, columns } });
  };

  const removeRow = (rowIndex: number) => {
    const result = tab.result;
    if (!result) return;
    const documents = result.documents.filter((_, index) => index !== rowIndex);
    onPatch({ result: { ...result, documents, totalReturned: documents.length } });
  };

  const filterByValue = (field: string, literal: string) => {
    const collection = tab.result?.collection ?? tab.collection;
    if (!collection) return;
    const key = /^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field);
    const code = `db.getCollection("${collection}").find({ ${key}: ${literal} })`;
    onPatch({ code });
    void run(null, code);
  };

  const editContext =
    tab.result?.collection && tab.result.kind === 'documents'
      ? {
          connectionId: tab.connectionId,
          database: tab.result.database ?? tab.database,
          collection: tab.result.collection,
          onOpenDocument: (idJson: string) =>
            setEditing({
              connectionId: tab.connectionId,
              database: tab.result?.database ?? tab.database,
              collection: tab.result?.collection as string,
              idJson
            }),
          onRowPatch: patchRow,
          onRowRemoved: removeRow,
          onFilterByValue: filterByValue,
          onRefresh: () => void run()
        }
      : undefined;

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

        {tab.collection ? (
          <Button
            size="sm"
            title={`Insert a document into ${tab.collection}`}
            onClick={() =>
              setEditing({
                connectionId: tab.connectionId,
                database: tab.database,
                collection: tab.collection as string
              })
            }
          >
            + Document
          </Button>
        ) : null}
        <Button size="sm" onClick={() => setSaveOpen(true)}>
          Save query
        </Button>
        <Button size="sm" onClick={() => setLibraryOpen(true)}>
          History
        </Button>

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
              {tab.result.kind === 'documents' && (tab.page > 0 || tab.result.truncated) ? (
                <span className="row" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    disabled={tab.page === 0 || tab.running}
                    onClick={() => goToPage(tab.page - 1)}
                    title="Previous page"
                  >
                    ‹
                  </Button>
                  <span className="faint">
                    rows {formatNumber(tab.page * tab.limit + 1)}–
                    {formatNumber(tab.page * tab.limit + tab.result.totalReturned)}
                  </span>
                  <Button
                    size="sm"
                    disabled={!tab.result.truncated || tab.running}
                    onClick={() => goToPage(tab.page + 1)}
                    title="Next page"
                  >
                    ›
                  </Button>
                </span>
              ) : tab.result.truncated ? (
                <Badge tone="amber">Truncated at the limit — raise it to see more</Badge>
              ) : null}
              {tab.result.explain ? <Badge tone="blue">Explain plan</Badge> : null}
              {editContext && mode === 'table' ? (
                <span className="faint">
                  Double-click a cell to edit it · right-click a row for more
                </span>
              ) : null}
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
          {!tab.error && tab.result ? (
            <ResultView
              result={tab.result}
              mode={mode}
              edit={editContext}
              rowOffset={tab.page * tab.limit}
            />
          ) : null}
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

      {libraryOpen ? (
        <QueryLibrary
          onClose={() => setLibraryOpen(false)}
          onOpen={(code, database) => {
            onPatch({ code, ...(database ? { database } : {}) });
            setLibraryOpen(false);
          }}
        />
      ) : null}

      {saveOpen ? (
        <SaveQueryDialog
          code={tab.code}
          database={tab.database}
          connectionId={tab.connectionId}
          onClose={() => setSaveOpen(false)}
          onSaved={(query) =>
            store.pushToast({ kind: 'success', message: `Saved “${query.name}”` })
          }
        />
      ) : null}

      {pendingWrite ? (
        <WriteGuardDialog
          writes={pendingWrite.writes}
          preview={pendingWrite.preview}
          checking={pendingWrite.checking}
          environment={environment}
          requireText={environment === 'production' ? confirmWord(pendingWrite) : null}
          onCancel={() => setPendingWrite(null)}
          onConfirm={() => {
            const { code, explain } = pendingWrite;
            setPendingWrite(null);
            void execute(code, explain);
          }}
        />
      ) : null}

      {editing ? (
        <DocumentEditor
          target={editing}
          onClose={() => setEditing(null)}
          onChanged={() => void run()}
        />
      ) : null}
    </div>
  );
}

/**
 * On production the user types the name of what is about to change: the
 * collection when there is only one, otherwise the database.
 */
function confirmWord(pending: PendingWrite): string {
  const namespaces = new Set((pending.preview ?? []).map((entry) => entry.namespace));
  if (namespaces.size === 1) {
    const [namespace] = [...namespaces];
    return namespace.split('.').slice(1).join('.') || namespace;
  }
  const collections = pending.writes.map((write) => write.collection).filter(Boolean);
  return collections.length === 1 ? (collections[0] as string) : 'production';
}
