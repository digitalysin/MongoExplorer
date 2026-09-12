import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionConfig } from '../shared/types';
import { ConnectionDialog } from './components/ConnectionDialog';
import { CreateDialog, type CreateTarget } from './components/CreateDialog';
import { ExportDialog } from './components/ExportDialog';
import { ImportDialog } from './components/ImportDialog';
import { QueryWorkspace, type QueryTabState } from './components/QueryWorkspace';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { StatsView, type StatsTabState } from './components/StatsView';
import { TransferStatus } from './components/TransferProgressPanel';
import { Button, EmptyState, Modal, TypeToConfirm } from './components/ui';
import { api, unwrap } from './lib/api';
import { useStore } from './state/store';

type Tab = QueryTabState | StatsTabState;

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  /** When set, the user has to type this word before the action is allowed. */
  requireText?: string;
  onConfirm: () => Promise<void> | void;
}

let tabCounter = 0;
const nextTabId = () => `tab-${(tabCounter += 1)}`;

export default function App() {
  const store = useStore();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [connectionDialog, setConnectionDialog] = useState<
    { open: true; initial: ConnectionConfig | null } | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<{
    connectionId: string;
    database: string;
    collection: string;
  } | null>(null);
  const [importTarget, setImportTarget] = useState<{
    connectionId: string;
    database: string;
    collection?: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [typed, setTyped] = useState('');
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );

  const openTab = useCallback((tab: Tab) => {
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((current) => {
        const next = current.filter((tab) => tab.id !== id);
        setActiveTabId((active) => (active === id ? (next.at(-1)?.id ?? null) : active));
        return next;
      });
    },
    [setActiveTabId]
  );

  const patchTab = useCallback((id: string, patch: Partial<QueryTabState>) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id && tab.kind === 'query' ? { ...tab, ...patch } : tab))
    );
  }, []);

  const openQueryTab = useCallback(
    (connectionId: string, database: string, collection: string | null, code?: string) => {
      const limit = store.settings?.defaultQueryLimit ?? 200;
      openTab({
        id: nextTabId(),
        kind: 'query',
        title: collection ? `${collection}` : database,
        connectionId,
        database,
        collection,
        code: code ?? (collection ? `db.getCollection("${collection}").find({})` : 'db.stats()'),
        limit,
        page: 0,
        result: null,
        error: null,
        running: false
      });
    },
    [openTab, store.settings?.defaultQueryLimit]
  );

  const openStatsTab = useCallback(
    (connectionId: string, database: string | null, collection: string | null) => {
      openTab({
        id: nextTabId(),
        kind: 'stats',
        title: collection ? `${collection} · stats` : database ? `${database} · stats` : 'Server',
        connectionId,
        database,
        collection
      });
    },
    [openTab]
  );

  // The File ▸ New Query Tab menu item routes through the main process.
  useEffect(() => {
    const selection = store.selection;
    return api.app.onNewTab(() => {
      if (!selection?.connectionId || !selection.database) return;
      openQueryTab(selection.connectionId, selection.database, selection.collection);
    });
  }, [openQueryTab, store.selection]);

  const dropCollection = (connectionId: string, database: string, collection: string) => {
    const perform = async () => {
      try {
        await unwrap(api.data.dropCollection(connectionId, database, collection));
        await store.loadCollections(connectionId, database, true);
        store.notify(`Dropped ${database}.${collection}`);
      } catch (error) {
        store.reportError('Could not drop the collection', error);
      }
    };
    if (store.settings?.confirmDestructiveOps === false) {
      void perform();
      return;
    }
    setConfirm({
      title: 'Drop collection',
      message: `${database}.${collection} and all of its documents will be deleted. This cannot be undone.`,
      confirmLabel: 'Drop collection',
      requireText: isProduction(connectionId) ? collection : undefined,
      onConfirm: perform
    });
  };

  const dropDatabase = (connectionId: string, database: string) => {
    const perform = async () => {
      try {
        await unwrap(api.data.dropDatabase(connectionId, database));
        setTabs((current) =>
          current.filter((tab) => !(tab.connectionId === connectionId && tab.database === database))
        );
        await store.loadDatabases(connectionId, true);
        store.select({ connectionId, database: null, collection: null });
        store.notify(`Dropped ${database}`);
      } catch (error) {
        store.reportError('Could not drop the database', error);
      }
    };
    if (store.settings?.confirmDestructiveOps === false) {
      void perform();
      return;
    }
    setConfirm({
      title: 'Drop database',
      message: `${database} and every collection inside it will be deleted. This cannot be undone.`,
      confirmLabel: 'Drop database',
      requireText: isProduction(connectionId) ? database : undefined,
      onConfirm: perform
    });
  };

  const onCreated = async (connectionId: string, database: string, collection: string) => {
    setCreateTarget(null);
    await store.loadDatabases(connectionId, true);
    await store.loadCollections(connectionId, database, true);
    store.select({ connectionId, database, collection });
    store.notify(`Created ${database}.${collection}`);
  };

  const deleteConnection = (config: ConnectionConfig) => {
    setConfirm({
      title: 'Delete connection',
      message: `"${config.name}" and its saved password will be removed from this computer. The database itself is not touched.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          await unwrap(api.connections.remove(config.id));
          setTabs((current) => current.filter((tab) => tab.connectionId !== config.id));
          await store.refreshConnections();
          store.notify(`Deleted the connection “${config.name}”`);
        } catch (error) {
          store.reportError('Could not delete the connection', error);
        }
      }
    });
  };

  // The typed confirmation starts empty for each new prompt.
  useEffect(() => setTyped(''), [confirm]);

  const isProduction = (connectionId: string) =>
    store.connections.find((entry) => entry.id === connectionId)?.environment === 'production';

  const selection = store.selection;
  const activeInfo = selection ? store.active[selection.connectionId] : null;
  const activeConfig = selection
    ? store.connections.find((entry) => entry.id === selection.connectionId)
    : undefined;

  return (
    <div className="app">
      <header className="titlebar" style={{ paddingLeft: navigator.platform.includes('Mac') ? 82 : 12 }}>
        <div className="brand">
          <span className="dot" />
          Mongo Explorer
        </div>
        <div className="titlebar-actions">
          <Button
            size="sm"
            disabled={!selection?.connectionId}
            onClick={() =>
              selection &&
              selection.database &&
              openQueryTab(selection.connectionId, selection.database, selection.collection)
            }
          >
            New query
          </Button>
          <Button
            size="sm"
            disabled={!selection?.connectionId}
            onClick={() =>
              selection &&
              openStatsTab(selection.connectionId, selection.database, selection.collection)
            }
          >
            Statistics
          </Button>
          <Button
            size="sm"
            disabled={!selection?.database || !selection.collection}
            onClick={() =>
              selection?.database &&
              selection.collection &&
              setExportTarget({
                connectionId: selection.connectionId,
                database: selection.database,
                collection: selection.collection
              })
            }
          >
            Export
          </Button>
          <Button
            size="sm"
            disabled={!selection?.database}
            onClick={() =>
              selection?.database &&
              setImportTarget({
                connectionId: selection.connectionId,
                database: selection.database,
                collection: selection.collection ?? undefined
              })
            }
          >
            Import
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            ⚙ Settings
          </Button>
        </div>
      </header>

      <Sidebar
        onNewConnection={() => setConnectionDialog({ open: true, initial: null })}
        onEditConnection={(config) => setConnectionDialog({ open: true, initial: config })}
        onDeleteConnection={deleteConnection}
        onOpenCollection={(connectionId, database, collection) =>
          openQueryTab(connectionId, database, collection)
        }
        onExport={(connectionId, database, collection) =>
          setExportTarget({ connectionId, database, collection })
        }
        onImport={(connectionId, database, collection) =>
          setImportTarget({ connectionId, database, collection })
        }
        onDropCollection={dropCollection}
        onCreateDatabase={(connectionId) => setCreateTarget({ kind: 'database', connectionId })}
        onCreateCollection={(connectionId, database) =>
          setCreateTarget({ kind: 'collection', connectionId, database })
        }
        onDropDatabase={dropDatabase}
      />

      <main className="main">
        {tabs.length > 0 ? (
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? 'is-active' : ''}`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span>{tab.kind === 'stats' ? '📊' : '⌗'}</span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {tab.title}
                </span>
                <span
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {activeTab?.kind === 'query' ? (
          <QueryWorkspace
            key={activeTab.id}
            tab={activeTab}
            onPatch={(patch) => patchTab(activeTab.id, patch)}
          />
        ) : null}

        {activeTab?.kind === 'stats' ? <StatsView key={activeTab.id} tab={activeTab} /> : null}

        {!activeTab ? (
          <EmptyState
            title="Connect to a MongoDB deployment"
            description={
              <>
                Create a connection in the sidebar, then double-click a collection to open a query
                tab. Statistics, import and export are available from the toolbar for whatever is
                selected.
              </>
            }
            action={
              <Button
                variant="primary"
                onClick={() => setConnectionDialog({ open: true, initial: null })}
              >
                New connection
              </Button>
            }
          />
        ) : null}
      </main>

      <footer className="statusbar">
        <div className="status-left">
          {activeInfo ? (
            <>
              <span>{activeInfo.name}</span>
              {activeConfig?.environment === 'production' ? (
                <span className="tag tag-prod">production</span>
              ) : null}
              {activeConfig?.readOnly ? <span className="tag tag-readonly">read-only</span> : null}
              <span className="truncate mono">{activeInfo.uriSafe}</span>
              <span>
                {activeInfo.topology} · MongoDB {activeInfo.serverVersion}
              </span>
            </>
          ) : (
            <span className="faint">Not connected</span>
          )}
        </div>
        <div className="status-right">
          {store.busy ? <span>Connecting…</span> : null}
          {selection?.database ? (
            <span className="mono">
              {selection.database}
              {selection.collection ? `.${selection.collection}` : ''}
            </span>
          ) : null}
          {store.activity[0] &&
          (store.activity[0].phase === 'running' || store.activity[0].phase === 'starting') ? (
            <TransferStatus progress={store.activity[0]} />
          ) : null}
        </div>
      </footer>

      <div className="toasts">
        {store.toasts.map((toast) => (
          <div key={toast.id} className={`toast kind-${toast.kind}`}>
            <div style={{ flex: 1 }}>
              <div>{toast.message}</div>
              {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
            </div>
            <button className="icon-button" onClick={() => store.dismissToast(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      {connectionDialog ? (
        <ConnectionDialog
          initial={connectionDialog.initial}
          onClose={() => setConnectionDialog(null)}
          onSaved={(config, connectNow) => {
            setConnectionDialog(null);
            if (connectNow) void store.connect(config.id);
          }}
        />
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      {createTarget ? (
        <CreateDialog
          target={createTarget}
          onClose={() => setCreateTarget(null)}
          onCreated={(database, collection) =>
            void onCreated(createTarget.connectionId, database, collection)
          }
        />
      ) : null}

      {exportTarget ? (
        <ExportDialog
          connectionId={exportTarget.connectionId}
          database={exportTarget.database}
          collection={exportTarget.collection}
          onClose={() => setExportTarget(null)}
        />
      ) : null}

      {importTarget ? (
        <ImportDialog
          connectionId={importTarget.connectionId}
          database={importTarget.database}
          collection={importTarget.collection}
          onClose={() => setImportTarget(null)}
          onImported={() =>
            void store.loadCollections(importTarget.connectionId, importTarget.database, true)
          }
        />
      ) : null}

      {/* Failures stop the user: a toast would fade before it was read. */}
      {store.errorReport ? (
        <Modal
          title="Something went wrong"
          subtitle={store.errorReport.message}
          onClose={store.dismissError}
          width={560}
          footer={
            <>
              <span className="spacer" />
              <Button variant="primary" onClick={store.dismissError}>
                Close
              </Button>
            </>
          }
        >
          {store.errorReport.detail ? (
            <div className="error-box" style={{ margin: 0 }}>
              {store.errorReport.detail}
            </div>
          ) : (
            <p style={{ margin: 0, lineHeight: 1.6 }}>
              No further detail was reported. Check the deployment and try again.
            </p>
          )}
        </Modal>
      ) : null}

      {confirm ? (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          width={460}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={Boolean(confirm.requireText) && typed.trim() !== confirm.requireText}
                onClick={async () => {
                  const action = confirm.onConfirm;
                  setConfirm(null);
                  await action();
                }}
              >
                {confirm.confirmLabel}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>{confirm.message}</p>
          {confirm.requireText ? (
            <TypeToConfirm word={confirm.requireText} value={typed} onChange={setTyped} />
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
