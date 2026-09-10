import { useMemo, useState } from 'react';
import type { QueryResult } from '../../shared/types';
import { formatCellValue, prettyJson, valueType } from '../lib/format';
import { EmptyState, Modal } from './ui';

export type ResultMode = 'table' | 'json';

/** Canonical EJSON for an `_id` taken from a relaxed-EJSON row. */
function idJsonOf(row: Record<string, unknown> | undefined): string | null {
  if (!row || !('_id' in row)) return null;
  const id = row._id;
  if (id && typeof id === 'object') {
    const record = id as Record<string, unknown>;
    if (typeof record.$oid === 'string') return JSON.stringify({ $oid: record.$oid });
    // Other BSON wrappers already are canonical enough to round-trip.
    return JSON.stringify(id);
  }
  if (typeof id === 'number') {
    return Number.isInteger(id)
      ? JSON.stringify({ $numberLong: String(id) })
      : JSON.stringify({ $numberDouble: String(id) });
  }
  return JSON.stringify(id);
}

export function ResultView({
  result,
  mode,
  onEditDocument
}: {
  result: QueryResult;
  mode: ResultMode;
  /** Absent when the result is not tied to a single editable collection. */
  onEditDocument?: (idJson: string) => void;
}) {
  const [inspected, setInspected] = useState<unknown>(null);

  const rows = useMemo(
    () => result.documents as Array<Record<string, unknown>>,
    [result.documents]
  );

  if (result.kind === 'acknowledgement') {
    return (
      <div style={{ padding: 16 }}>
        <pre className="json-view" style={{ padding: 0 }}>
          {prettyJson(result.value)}
        </pre>
      </div>
    );
  }

  if (result.kind === 'value') {
    return (
      <div style={{ padding: 20 }}>
        <div className="stat-tile" style={{ maxWidth: 260 }}>
          <span className="stat-label">Result</span>
          <span className="stat-value">{String(result.value)}</span>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No documents returned"
        description="The query ran successfully but matched nothing."
      />
    );
  }

  if (mode === 'json') {
    return <pre className="json-view">{prettyJson(rows)}</pre>;
  }

  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 52 }}>#</th>
            {result.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const idJson = idJsonOf(row);
            const editable = Boolean(onEditDocument && idJson);
            return (
            <tr key={index} onDoubleClick={() => setInspected(row)}>
              <td
                className="cell-index"
                title={editable ? 'Edit this document' : undefined}
                onClick={() => editable && onEditDocument?.(idJson as string)}
                style={editable ? { cursor: 'pointer' } : undefined}
              >
                {editable ? '✎ ' : ''}
                {index + 1}
              </td>
              {result.columns.map((column) => {
                const value = row?.[column];
                const type = valueType(value);
                const expandable = value !== null && typeof value === 'object';
                return (
                  <td
                    key={column}
                    title={expandable ? 'Double-click to inspect' : formatCellValue(value)}
                    onDoubleClick={(event) => {
                      if (!expandable) return;
                      event.stopPropagation();
                      setInspected(value);
                    }}
                  >
                    <span className={`cell type-${type}`}>
                      {value === undefined ? '' : formatCellValue(value)}
                    </span>
                  </td>
                );
              })}
            </tr>
            );
          })}
        </tbody>
      </table>

      {inspected !== null ? (
        <Modal title="Document" onClose={() => setInspected(null)} width={760}>
          <pre className="json-view" style={{ padding: 0 }}>
            {prettyJson(inspected)}
          </pre>
        </Modal>
      ) : null}
    </>
  );
}
