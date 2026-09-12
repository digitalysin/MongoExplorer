import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProfilerSnapshot, RunningOperation } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { formatElapsed, formatNumber } from '../lib/format';
import { useStore } from '../state/store';
import { Badge, Button, Checkbox, EmptyState, Modal, Spinner, TextInput, TypeToConfirm } from './ui';

export interface OperationsTabState {
  id: string;
  kind: 'operations';
  title: string;
  connectionId: string;
  database: string | null;
}

const REFRESH_MS = 2000;

/** Operations the app itself is running are noise when you are hunting a problem. */
function isOurs(operation: RunningOperation): boolean {
  return operation.appName === 'Mongo Explorer';
}

function ageLabel(seconds: number | null): string {
  if (seconds === null) return '—';
  return seconds < 1 ? '<1s' : formatElapsed(seconds * 1000);
}

/**
 * What the deployment is doing right now, and what the profiler noticed was
 * slow. The point of the panel is the answer to “why is it struggling?”, so it
 * refreshes itself and puts the oldest operation at the top.
 */
export function OperationsView({ tab }: { tab: OperationsTabState }) {
  const store = useStore();
  const [operations, setOperations] = useState<RunningOperation[] | null>(null);
  const [profiler, setProfiler] = useState<ProfilerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [includeIdle, setIncludeIdle] = useState(false);
  const [hideOwn, setHideOwn] = useState(true);
  const [live, setLive] = useState(true);
  const [killing, setKilling] = useState<RunningOperation | null>(null);
  const [typed, setTyped] = useState('');
  // A refresh that lands after the tab closed must not set state.
  const mounted = useRef(true);

  const connection = store.connections.find((entry) => entry.id === tab.connectionId);
  const production = connection?.environment === 'production';

  const load = useCallback(async () => {
    try {
      const running = await unwrap(api.ops.current(tab.connectionId, { includeIdle }));
      if (!mounted.current) return;
      setOperations(running);
      setError(null);
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
    }
  }, [includeIdle, tab.connectionId]);

  const loadProfiler = useCallback(async () => {
    if (!tab.database) return;
    try {
      const snapshot = await unwrap(api.ops.profiler(tab.connectionId, tab.database, 25));
      if (mounted.current) setProfiler(snapshot);
    } catch {
      // The profiler is a bonus; failing to read it must not hide the live list.
      if (mounted.current) setProfiler(null);
    }
  }, [tab.connectionId, tab.database]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void load();
    void loadProfiler();
    if (!live) return;
    const timer = setInterval(() => {
      void load();
      void loadProfiler();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load, loadProfiler]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (operations ?? []).filter((operation) => {
      if (hideOwn && isOurs(operation)) return false;
      if (!needle) return true;
      return [operation.namespace, operation.op, operation.command, operation.appName, operation.client]
        .filter(Boolean)
        .some((field) => (field as string).toLowerCase().includes(needle));
    });
  }, [filter, hideOwn, operations]);

  const kill = async (operation: RunningOperation) => {
    try {
      await unwrap(api.ops.kill(tab.connectionId, operation.opid));
      store.notify(`Stopped operation ${operation.opid}`);
      await load();
    } catch (caught) {
      store.reportError(`Could not stop operation ${operation.opid}`, caught);
    }
  };

  return (
    <div className="stats-view">
      <div className="stats-header">
        <h2>Operations on {connection?.name ?? 'this deployment'}</h2>
      </div>

      <div className="ops-controls">
        <TextInput
          value={filter}
          placeholder="Filter by namespace, command or app…"
          style={{ width: 280 }}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Checkbox label="Idle too" checked={includeIdle} onChange={setIncludeIdle} />
        <Checkbox label="Hide this app" checked={hideOwn} onChange={setHideOwn} />
        <Checkbox label="Live" checked={live} onChange={setLive} />
        <span className="spacer" />
        <Button size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      <section className="stats-section">
        <h3>
          Running now
          <span className="faint" style={{ fontWeight: 400, marginLeft: 8 }}>
            {operations === null
              ? 'loading…'
              : `${formatNumber(shown.length)} operation${shown.length === 1 ? '' : 's'}${
                  live ? ' · refreshing every 2s' : ''
                }`}
          </span>
        </h3>

        {operations === null ? (
          <Spinner label="Asking the server what it is doing…" />
        ) : shown.length === 0 ? (
          <EmptyState
            title="Nothing is running"
            description="The deployment is idle, or everything running is filtered out of this list."
          />
        ) : (
          <table className="stats-table ops-table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>Age</th>
                <th style={{ width: 90 }}>Op</th>
                <th style={{ width: 200 }}>Namespace</th>
                <th>Command</th>
                <th style={{ width: 150 }}>Client</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {shown.map((operation) => (
                <tr key={operation.opid}>
                  <td className="mono">{ageLabel(operation.secondsRunning)}</td>
                  <td>
                    {operation.op ?? '—'}
                    {operation.waitingForLock ? (
                      <>
                        {' '}
                        <Badge tone="amber">waiting</Badge>
                      </>
                    ) : null}
                  </td>
                  <td className="mono">{operation.namespace ?? '—'}</td>
                  <td className="mono faint" title={operation.command ?? undefined}>
                    <span className="truncate-cell">{operation.command ?? '—'}</span>
                    {operation.planSummary ? (
                      <div className="faint">{operation.planSummary}</div>
                    ) : null}
                  </td>
                  <td className="mono faint">
                    <span className="truncate-cell">
                      {operation.appName || operation.client || '—'}
                    </span>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={connection?.readOnly}
                      title={
                        connection?.readOnly
                          ? 'This connection is read-only'
                          : `Stop operation ${operation.opid}`
                      }
                      onClick={() => {
                        setTyped('');
                        setKilling(operation);
                      }}
                    >
                      Stop
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="stats-section">
        <h3>
          Slow operations
          {profiler ? (
            <span className="faint" style={{ fontWeight: 400, marginLeft: 8 }}>
              {tab.database} · profiling{' '}
              {profiler.level === 0
                ? 'off'
                : `level ${profiler.level}, over ${formatNumber(profiler.slowMs)} ms`}
            </span>
          ) : null}
        </h3>

        {!tab.database ? (
          <EmptyState
            title="Pick a database"
            description="The profiler records per database, so open this panel with one selected."
          />
        ) : profiler === null ? (
          <Spinner label="Reading the profiler…" />
        ) : profiler.level === 0 ? (
          <EmptyState
            title="Profiling is off"
            description={
              <>
                Nothing is being recorded for <code>{tab.database}</code>. Turn it on from a query
                tab with{' '}
                <code>db.runCommand(&#123; profile: 1, slowms: 100 &#125;)</code> — and remember to
                turn it back off, since it writes every slow operation to{' '}
                <code>system.profile</code>.
              </>
            }
          />
        ) : profiler.operations.length === 0 ? (
          <EmptyState
            title="Nothing slow yet"
            description={`Profiling is on, but nothing has taken longer than ${formatNumber(
              profiler.slowMs
            )} ms.`}
          />
        ) : (
          <table className="stats-table ops-table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>Took</th>
                <th style={{ width: 90 }}>Op</th>
                <th style={{ width: 200 }}>Namespace</th>
                <th>Command</th>
                <th style={{ width: 170 }}>Examined / returned</th>
              </tr>
            </thead>
            <tbody>
              {profiler.operations.map((operation, index) => (
                <tr key={`${operation.at}-${index}`}>
                  <td className="mono">{formatNumber(operation.millis)} ms</td>
                  <td>{operation.op ?? '—'}</td>
                  <td className="mono">{operation.namespace ?? '—'}</td>
                  <td className="mono faint" title={operation.command ?? undefined}>
                    <span className="truncate-cell">{operation.command ?? '—'}</span>
                    {operation.planSummary ? (
                      <div className="faint">{operation.planSummary}</div>
                    ) : null}
                  </td>
                  <td className="mono faint">
                    {operation.documentsExamined === null
                      ? '—'
                      : `${formatNumber(operation.documentsExamined)} / ${formatNumber(
                          operation.returned ?? 0
                        )}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {killing ? (
        <Modal
          title={`Stop operation ${killing.opid}?`}
          onClose={() => setKilling(null)}
          width={480}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setKilling(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={production && typed.trim() !== killing.opid}
                onClick={() => {
                  const operation = killing;
                  setKilling(null);
                  void kill(operation);
                }}
              >
                Stop it
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            {killing.op ?? 'The operation'} on{' '}
            <span className="mono">{killing.namespace ?? 'an unknown namespace'}</span> has been
            running for {ageLabel(killing.secondsRunning)}. Stopping it makes the client that sent
            it fail; a write already applied stays applied.
          </p>
          {production ? (
            <TypeToConfirm word={killing.opid} value={typed} onChange={setTyped} />
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
