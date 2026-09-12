import { useState } from 'react';
import type { ConnectionEnvironment, QueryWritePreview } from '../../shared/types';
import type { DetectedWrite } from '../../shared/writeOps';
import { formatNumber } from '../lib/format';
import { Badge, Button, Modal, Spinner, TypeToConfirm } from './ui';

/**
 * Stands between a query that writes and the data it would write to. The
 * numbers come from a dry run: the same code, with its writes counted instead
 * of performed.
 */
export function WriteGuardDialog({
  writes,
  preview,
  checking,
  environment,
  requireText,
  onCancel,
  onConfirm
}: {
  writes: DetectedWrite[];
  preview: QueryWritePreview[] | null;
  checking: boolean;
  environment: ConnectionEnvironment;
  /** When set, the user has to type this before the run is allowed. */
  requireText: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const armed = !checking && (!requireText || typed.trim() === requireText);

  const total = (preview ?? []).reduce(
    (sum, entry) => (entry.affected === null ? sum : sum + entry.affected),
    0
  );

  return (
    <Modal
      title="This query writes to your data"
      subtitle={
        checking
          ? 'Counting what it would change, without changing anything…'
          : 'Nothing has run yet. Here is what it would do.'
      }
      onClose={onCancel}
      width={600}
      footer={
        <>
          {environment === 'production' ? <Badge tone="red">Production</Badge> : null}
          {!checking && total > 0 ? (
            <span className="dim">
              {formatNumber(total)} document{total === 1 ? '' : 's'} in total
            </span>
          ) : null}
          <span className="spacer" />
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={!armed}>
            Run it
          </Button>
        </>
      }
    >
      {checking ? (
        <Spinner label="Working out what this would change…" />
      ) : (
        <>
          {(preview ?? []).length > 0 ? (
            <ul className="write-list">
              {(preview ?? []).map((entry, index) => (
                <li key={`${entry.method}-${entry.namespace}-${index}`}>
                  <span className="mono">{entry.method}</span> on{' '}
                  <span className="mono">{entry.namespace}</span>
                  <div className="faint">
                    {entry.affected === null
                      ? (entry.note ?? 'the effect cannot be counted in advance')
                      : `${formatNumber(entry.affected)} document${
                          entry.affected === 1 ? '' : 's'
                        }${entry.note ? ` — ${entry.note}` : ''}`}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
              The dry run reached no write, but the query does contain{' '}
              {writes.map((write) => write.method).join(', ')}. It may still write when it runs for
              real — a write inside a branch or a loop is only reached with real results.
            </p>
          )}

          {requireText ? (
            <TypeToConfirm word={requireText} value={typed} onChange={setTyped} />
          ) : null}
        </>
      )}
    </Modal>
  );
}
