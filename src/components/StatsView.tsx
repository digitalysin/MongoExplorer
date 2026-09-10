import { useCallback, useEffect, useState } from 'react';
import type { CollectionStats, DatabaseStats, ServerInfo } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import {
  describeIndexKeys,
  formatBytes,
  formatNumber,
  formatUptime
} from '../lib/format';
import { IndexDialog } from './IndexDialog';
import { Badge, Button, Spinner, StatTile } from './ui';

export interface StatsTabState {
  id: string;
  kind: 'stats';
  title: string;
  connectionId: string;
  database: string | null;
  collection: string | null;
}

export function StatsView({ tab }: { tab: StatsTabState }) {
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [database, setDatabase] = useState<DatabaseStats | null>(null);
  const [collection, setCollection] = useState<CollectionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingIndex, setCreatingIndex] = useState(false);
  const [droppingIndex, setDroppingIndex] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [serverInfo, databaseStats, collectionStats] = await Promise.all([
        unwrap(api.data.serverInfo(tab.connectionId)),
        tab.database
          ? unwrap(api.data.databaseStats(tab.connectionId, tab.database))
          : Promise.resolve(null),
        tab.database && tab.collection
          ? unwrap(api.data.collectionStats(tab.connectionId, tab.database, tab.collection))
          : Promise.resolve(null)
      ]);
      setServer(serverInfo);
      setDatabase(databaseStats);
      setCollection(collectionStats);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [tab.collection, tab.connectionId, tab.database]);

  useEffect(() => {
    void load();
  }, [load]);

  const dropIndexNamed = (name: string) => setDroppingIndex(name);

  const confirmDropIndex = async () => {
    if (!droppingIndex || !tab.database || !tab.collection) return;
    try {
      await unwrap(
        api.data.dropIndex(tab.connectionId, tab.database, tab.collection, droppingIndex)
      );
      setDroppingIndex(null);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
      setDroppingIndex(null);
    }
  };

  if (loading && !server) {
    return (
      <div style={{ padding: 24 }}>
        <Spinner label="Reading statistics…" />
      </div>
    );
  }

  const largest = database?.collections[0]?.dataSizeBytes ?? 1;

  return (
    <div className="stats-page">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>
          {collection
            ? `${tab.database}.${tab.collection}`
            : (tab.database ?? 'Server statistics')}
        </h2>
        <Button size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner label="Refreshing…" /> : '⟳ Refresh'}
        </Button>
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      {collection ? (
        <>
          <section className="stats-section">
            <h3>Collection</h3>
            <div className="stat-grid">
              <StatTile label="Documents" value={formatNumber(collection.documentCount)} />
              <StatTile
                label="Data size"
                value={formatBytes(collection.dataSizeBytes)}
                sub={`avg ${formatBytes(collection.avgObjectSizeBytes)} / doc`}
              />
              <StatTile
                label="Storage size"
                value={formatBytes(collection.storageSizeBytes)}
                sub={
                  collection.dataSizeBytes > 0
                    ? `${((collection.storageSizeBytes / collection.dataSizeBytes) * 100).toFixed(0)}% of data size`
                    : undefined
                }
              />
              <StatTile
                label="Indexes"
                value={formatNumber(collection.indexCount)}
                sub={formatBytes(collection.totalIndexSizeBytes)}
              />
              {collection.capped ? <StatTile label="Capped" value="Yes" /> : null}
              {collection.shardKey ? (
                <StatTile label="Shard key" value={describeIndexKeys(collection.shardKey)} />
              ) : null}
            </div>
          </section>

          <section className="stats-section">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: '0 0 10px' }}>Indexes</h3>
              <Button size="sm" onClick={() => setCreatingIndex(true)}>
                + Create index
              </Button>
            </div>
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Keys</th>
                  <th>Properties</th>
                  <th className="numeric">Size</th>
                  <th className="numeric">Uses</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {collection.indexes.map((index) => (
                  <tr key={index.name}>
                    <td className="mono">{index.name}</td>
                    <td className="mono dim">{describeIndexKeys(index.keys)}</td>
                    <td>
                      <span className="row" style={{ gap: 4 }}>
                        {index.unique ? <Badge tone="blue">unique</Badge> : null}
                        {index.sparse ? <Badge>sparse</Badge> : null}
                        {index.ttlSeconds !== null ? (
                          <Badge tone="amber">TTL {index.ttlSeconds}s</Badge>
                        ) : null}
                      </span>
                    </td>
                    <td className="numeric">{formatBytes(index.sizeBytes)}</td>
                    <td className="numeric">{formatNumber(index.usageCount)}</td>
                    <td>
                      {index.name === '_id_' ? null : (
                        <button
                          className="icon-button"
                          title="Drop this index"
                          onClick={() => void dropIndexNamed(index.name)}
                        >
                          🗑
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {droppingIndex ? (
              <p className="dim" style={{ marginTop: 8 }}>
                Drop the index <span className="inline-code">{droppingIndex}</span>? Queries that
                rely on it will fall back to a collection scan.{' '}
                <Button size="sm" variant="danger" onClick={() => void confirmDropIndex()}>
                  Drop it
                </Button>{' '}
                <Button size="sm" onClick={() => setDroppingIndex(null)}>
                  Cancel
                </Button>
              </p>
            ) : null}
          </section>

          <section className="stats-section">
            <h3>Fields (sampled from up to 200 documents)</h3>
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Types</th>
                  <th className="numeric">Present in</th>
                </tr>
              </thead>
              <tbody>
                {collection.sampledFields.map((field) => (
                  <tr key={field.field}>
                    <td className="mono">{field.field}</td>
                    <td className="dim">{field.types.join(', ')}</td>
                    <td className="numeric">{field.presencePercent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}

      {database && !collection ? (
        <>
          <section className="stats-section">
            <h3>Database</h3>
            <div className="stat-grid">
              <StatTile label="Collections" value={formatNumber(database.collectionCount)} />
              <StatTile label="Views" value={formatNumber(database.viewCount)} />
              <StatTile label="Documents" value={formatNumber(database.objectCount)} />
              <StatTile
                label="Data size"
                value={formatBytes(database.dataSizeBytes)}
                sub={`avg ${formatBytes(database.avgObjectSizeBytes)} / doc`}
              />
              <StatTile label="Storage size" value={formatBytes(database.storageSizeBytes)} />
              <StatTile
                label="Indexes"
                value={formatNumber(database.indexCount)}
                sub={formatBytes(database.indexSizeBytes)}
              />
              {database.fsTotalSizeBytes ? (
                <StatTile
                  label="Filesystem"
                  value={formatBytes(database.fsUsedSizeBytes)}
                  sub={`of ${formatBytes(database.fsTotalSizeBytes)}`}
                />
              ) : null}
            </div>
          </section>

          <section className="stats-section">
            <h3>Collections by size</h3>
            <table className="plain-table">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th className="numeric">Documents</th>
                  <th className="numeric">Data</th>
                  <th className="numeric">Storage</th>
                  <th className="numeric">Indexes</th>
                  <th style={{ width: 140 }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {database.collections.map((entry) => (
                  <tr key={entry.name}>
                    <td className="mono">{entry.name}</td>
                    <td className="numeric">{formatNumber(entry.documentCount)}</td>
                    <td className="numeric">{formatBytes(entry.dataSizeBytes)}</td>
                    <td className="numeric">{formatBytes(entry.storageSizeBytes)}</td>
                    <td className="numeric">
                      {formatNumber(entry.indexCount)} · {formatBytes(entry.indexSizeBytes)}
                    </td>
                    <td>
                      <span className="bar">
                        <span
                          style={{
                            width: `${Math.max((entry.dataSizeBytes / Math.max(largest, 1)) * 100, 1)}%`
                          }}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}

      {server ? (
        <section className="stats-section">
          <h3>Server</h3>
          <div className="stat-grid">
            <StatTile label="MongoDB" value={server.version} sub={server.topology} />
            <StatTile label="Host" value={server.host ?? '—'} sub={server.process ?? undefined} />
            <StatTile label="Uptime" value={formatUptime(server.uptimeSeconds)} />
            <StatTile
              label="Connections"
              value={formatNumber(server.currentConnections)}
              sub={
                server.availableConnections !== null
                  ? `${formatNumber(server.availableConnections)} available`
                  : undefined
              }
            />
            <StatTile label="Storage engine" value={server.storageEngine ?? '—'} />
            <StatTile label="Max BSON size" value={formatBytes(server.maxBsonObjectSize)} />
          </div>
        </section>
      ) : null}

      {creatingIndex && tab.database && tab.collection ? (
        <IndexDialog
          connectionId={tab.connectionId}
          database={tab.database}
          collection={tab.collection}
          onClose={() => setCreatingIndex(false)}
          onCreated={() => void load()}
        />
      ) : null}
    </div>
  );
}
