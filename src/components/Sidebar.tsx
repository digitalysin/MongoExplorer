import { useState } from 'react';
import type { ConnectionConfig } from '../../shared/types';
import { formatBytes, formatNumber } from '../lib/format';
import { collectionsKey, useStore } from '../state/store';
import { Button, Spinner } from './ui';

interface SidebarProps {
  onNewConnection: () => void;
  onEditConnection: (config: ConnectionConfig) => void;
  onDeleteConnection: (config: ConnectionConfig) => void;
  onOpenCollection: (connectionId: string, database: string, collection: string) => void;
  onExport: (connectionId: string, database: string, collection: string) => void;
  onImport: (connectionId: string, database: string, collection?: string) => void;
  onDropCollection: (connectionId: string, database: string, collection: string) => void;
  onCreateDatabase: (connectionId: string) => void;
  onCreateCollection: (connectionId: string, database: string) => void;
  onDropDatabase: (connectionId: string, database: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const store = useStore();
  const [expandedConnections, setExpandedConnections] = useState<Record<string, boolean>>({});
  const [expandedDatabases, setExpandedDatabases] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

  const toggleConnection = async (config: ConnectionConfig) => {
    const isOpen = expandedConnections[config.id];
    setExpandedConnections((current) => ({ ...current, [config.id]: !isOpen }));
    if (!isOpen) {
      if (!store.isConnected(config.id)) {
        const connected = await store.connect(config.id);
        if (!connected) {
          setExpandedConnections((current) => ({ ...current, [config.id]: false }));
          return;
        }
      }
      await store.loadDatabases(config.id);
    }
  };

  const toggleDatabase = async (connectionId: string, database: string) => {
    const key = collectionsKey(connectionId, database);
    const isOpen = expandedDatabases[key];
    setExpandedDatabases((current) => ({ ...current, [key]: !isOpen }));
    store.select({ connectionId, database, collection: null });
    if (!isOpen) await store.loadCollections(connectionId, database);
  };

  const matchesFilter = (text: string) =>
    filter.trim() === '' || text.toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Connections</span>
        <div className="row">
          <Button size="sm" variant="ghost" title="Refresh" onClick={store.refreshConnections}>
            ⟳
          </Button>
          <Button size="sm" variant="primary" onClick={props.onNewConnection}>
            + New
          </Button>
        </div>
      </div>

      <div style={{ padding: '8px 10px' }}>
        <input
          className="input"
          placeholder="Filter databases and collections…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="sidebar-body">
        {store.connections.length === 0 ? (
          <p className="faint" style={{ padding: '12px 14px', lineHeight: 1.6 }}>
            No connections yet. Create one to get started — each is stored separately with its own
            host, credentials and TLS settings.
          </p>
        ) : null}

        {store.connections.map((config) => {
          const connected = store.isConnected(config.id);
          const open = Boolean(expandedConnections[config.id]);
          const databases = store.databases[config.id] ?? [];

          return (
            <div key={config.id}>
              <div
                className={`connection-row ${store.selection?.connectionId === config.id ? 'is-active' : ''}`}
                onClick={() => void toggleConnection(config)}
              >
                <span className="caret" style={{ width: 12, color: 'var(--text-faint)' }}>
                  {open ? '▾' : '▸'}
                </span>
                <span
                  className={`status-dot ${connected ? 'online' : ''}`}
                  style={config.color && connected ? { background: config.color } : undefined}
                  title={connected ? 'Connected' : 'Not connected'}
                />
                <span className="name" title={config.name}>
                  {config.name}
                </span>
                <span className="row-actions" onClick={(event) => event.stopPropagation()}>
                  {connected ? (
                    <>
                      <button
                        className="icon-button"
                        title="New database"
                        onClick={() => props.onCreateDatabase(config.id)}
                      >
                        ＋
                      </button>
                      <button
                        className="icon-button"
                        title="Disconnect"
                        onClick={() => void store.disconnect(config.id)}
                      >
                        ⏻
                      </button>
                    </>
                  ) : null}
                  <button
                    className="icon-button"
                    title="Edit connection"
                    onClick={() => props.onEditConnection(config)}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-button"
                    title="Delete connection"
                    onClick={() => props.onDeleteConnection(config)}
                  >
                    🗑
                  </button>
                </span>
              </div>

              {open && store.loadingKeys[config.id] ? (
                <div style={{ padding: '4px 22px' }}>
                  <Spinner label="Loading databases…" />
                </div>
              ) : null}

              {open
                ? databases
                    .filter(
                      (database) =>
                        matchesFilter(database.name) ||
                        (store.collections[collectionsKey(config.id, database.name)] ?? []).some(
                          (collection) => matchesFilter(collection.name)
                        )
                    )
                    .map((database) => {
                      const key = collectionsKey(config.id, database.name);
                      const dbOpen = Boolean(expandedDatabases[key]);
                      const collections = store.collections[key] ?? [];
                      const selected =
                        store.selection?.connectionId === config.id &&
                        store.selection.database === database.name &&
                        !store.selection.collection;

                      return (
                        <div key={key}>
                          <button
                            className={`tree-node level-1 ${selected ? 'is-selected' : ''}`}
                            onClick={() => void toggleDatabase(config.id, database.name)}
                          >
                            <span className="caret">{dbOpen ? '▾' : '▸'}</span>
                            <span className="icon">🗄</span>
                            <span className="label" title={database.name}>
                              {database.name}
                            </span>
                            <span className="meta">{formatBytes(database.sizeOnDisk)}</span>
                            <span className="row-actions">
                              <span
                                className="icon-button"
                                title="Create collection"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.onCreateCollection(config.id, database.name);
                                }}
                              >
                                ＋
                              </span>
                              <span
                                className="icon-button"
                                title="Import into this database"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.onImport(config.id, database.name);
                                }}
                              >
                                ⇤
                              </span>
                              <span
                                className="icon-button"
                                title="Drop database"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.onDropDatabase(config.id, database.name);
                                }}
                              >
                                🗑
                              </span>
                            </span>
                          </button>

                          {dbOpen && store.loadingKeys[key] ? (
                            <div style={{ padding: '4px 40px' }}>
                              <Spinner label="Loading collections…" />
                            </div>
                          ) : null}

                          {dbOpen
                            ? collections
                                .filter((collection) => matchesFilter(collection.name))
                                .map((collection) => {
                                  const isSelected =
                                    store.selection?.connectionId === config.id &&
                                    store.selection.database === database.name &&
                                    store.selection.collection === collection.name;
                                  return (
                                    <button
                                      key={collection.name}
                                      className={`tree-node level-2 ${isSelected ? 'is-selected' : ''}`}
                                      onClick={() =>
                                        store.select({
                                          connectionId: config.id,
                                          database: database.name,
                                          collection: collection.name
                                        })
                                      }
                                      onDoubleClick={() =>
                                        props.onOpenCollection(
                                          config.id,
                                          database.name,
                                          collection.name
                                        )
                                      }
                                    >
                                      <span className="caret" />
                                      <span className="icon">
                                        {collection.type === 'view'
                                          ? '👁'
                                          : collection.type === 'timeseries'
                                            ? '⏱'
                                            : '▤'}
                                      </span>
                                      <span className="label" title={collection.name}>
                                        {collection.name}
                                      </span>
                                      <span className="meta">
                                        {formatNumber(collection.documentCount)}
                                      </span>
                                      <span className="row-actions">
                                        <span
                                          className="icon-button"
                                          title="Export collection"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            props.onExport(
                                              config.id,
                                              database.name,
                                              collection.name
                                            );
                                          }}
                                        >
                                          ⇥
                                        </span>
                                        <span
                                          className="icon-button"
                                          title="Import into collection"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            props.onImport(
                                              config.id,
                                              database.name,
                                              collection.name
                                            );
                                          }}
                                        >
                                          ⇤
                                        </span>
                                        <span
                                          className="icon-button"
                                          title="Drop collection"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            props.onDropCollection(
                                              config.id,
                                              database.name,
                                              collection.name
                                            );
                                          }}
                                        >
                                          🗑
                                        </span>
                                      </span>
                                    </button>
                                  );
                                })
                            : null}
                        </div>
                      );
                    })
                : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
