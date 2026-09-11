import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { DocumentRef, QueryResult } from '../../shared/types';
import { api, errorMessage, unwrap } from '../lib/api';
import { cellEditHint, cellEditor, cellValueJson, type CellEditKind } from '../lib/cellEdit';
import { formatCellValue, prettyJson, shellLiteral, valueType } from '../lib/format';
import { useStore } from '../state/store';
import { Button, ContextMenu, EmptyState, Modal, type MenuItem } from './ui';

export type ResultMode = 'table' | 'json';

/** Everything the table needs to write back to the collection it came from. */
export interface ResultEditContext {
  connectionId: string;
  database: string;
  collection: string;
  /** Opens the full document in the JSON editor. */
  onOpenDocument: (idJson: string) => void;
  /** Repaints one cell after a confirmed write; `undefined` drops the field. */
  onRowPatch: (rowIndex: number, field: string, value: unknown) => void;
  onRowRemoved: (rowIndex: number) => void;
  /** Replaces the query with one filtering on the clicked value. */
  onFilterByValue: (field: string, literal: string) => void;
  onRefresh: () => void;
}

interface CellRef {
  row: number;
  column: string;
}

interface EditState extends CellRef {
  kind: CellEditKind;
  /** Captured when the edit opens, so a re-run cannot redirect the write. */
  idJson: string;
  /** The text the cell started with, so an untouched edit writes nothing. */
  initial: string;
  draft: string;
}

interface MenuState {
  x: number;
  y: number;
  row: number;
  /** Null when the menu was opened from the row-number column. */
  column: string | null;
}

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

/** The plain text behind a cell, for the clipboard. */
function clipboardText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  const editor = cellEditor(value);
  return editor && editor.kind !== 'literal' ? editor.text : prettyJson(value);
}

export function ResultView({
  result,
  mode,
  edit
}: {
  result: QueryResult;
  mode: ResultMode;
  /** Absent when the result is not tied to a single editable collection. */
  edit?: ResultEditContext;
}) {
  const store = useStore();
  const [inspected, setInspected] = useState<unknown>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ row: number; idJson: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Escape unmounts the input, which also fires blur — this tells them apart.
  const cancelledRef = useRef(false);
  // Enter commits and unmounts the input, whose blur would otherwise write twice.
  const writingRef = useRef(false);
  // Distinguishes rows we just wrote ourselves from a freshly run query.
  const selfWriteRef = useRef(false);

  const rows = useMemo(
    () => result.documents as Array<Record<string, unknown>>,
    [result.documents]
  );
  const columns = result.columns;

  // A new set of documents means the rows under the cursor moved.
  useEffect(() => {
    if (selfWriteRef.current) {
      selfWriteRef.current = false;
      return;
    }
    setEditing(null);
    setSelected(null);
    setMenu(null);
  }, [rows]);

  const refFor = (idJson: string | null): DocumentRef | null => {
    if (!edit || !idJson) return null;
    return {
      connectionId: edit.connectionId,
      database: edit.database,
      collection: edit.collection,
      idJson
    };
  };

  const refForRow = (rowIndex: number): DocumentRef | null => refFor(idJsonOf(rows[rowIndex]));

  /** Applies a confirmed write without letting it clear the cursor. */
  const applyPatch = (rowIndex: number, field: string, value: unknown) => {
    selfWriteRef.current = true;
    edit?.onRowPatch(rowIndex, field, value);
  };

  const notify = (message: string) => store.pushToast({ kind: 'info', message });

  const fail = (message: string, error: unknown) =>
    store.pushToast({ kind: 'error', message, detail: errorMessage(error) });

  const copy = async (text: string, label: string) => {
    try {
      await unwrap(api.app.copyToClipboard(text));
      store.pushToast({ kind: 'success', message: `Copied ${label}` });
    } catch (error) {
      fail('Could not copy to the clipboard', error);
    }
  };

  const startEdit = (rowIndex: number, column: string) => {
    if (!edit) return;
    if (column === '_id') {
      notify('The _id of an existing document cannot be changed.');
      return;
    }
    const idJson = idJsonOf(rows[rowIndex]);
    if (!idJson) {
      notify('This row has no _id, so it cannot be edited in place.');
      return;
    }
    const editor = cellEditor(rows[rowIndex]?.[column]);
    if (!editor) {
      notify(`“${column}” holds a value that needs the document editor.`);
      return;
    }
    setSelected({ row: rowIndex, column });
    setEditing({
      row: rowIndex,
      column,
      idJson,
      kind: editor.kind,
      initial: editor.text,
      draft: editor.text
    });
  };

  /** Writes the edited cell, then optionally opens the editor on another cell. */
  const commit = async (active: EditState, next?: CellRef) => {
    if (writingRef.current) return;
    const ref = refFor(active.idJson);
    if (!ref) return;

    const moveOn = () => {
      setEditing(null);
      if (next) startEdit(next.row, next.column);
      else gridRef.current?.focus();
    };

    if (active.draft === active.initial) {
      moveOn();
      return;
    }

    let valueJson: string;
    try {
      valueJson = cellValueJson(active.kind, active.draft);
    } catch (error) {
      store.pushToast({ kind: 'error', message: errorMessage(error) });
      return;
    }

    writingRef.current = true;
    setSaving(true);
    try {
      const { value } = await unwrap(api.data.setDocumentField(ref, active.column, valueJson));
      applyPatch(active.row, active.column, value);
      moveOn();
    } catch (error) {
      fail(`Could not update “${active.column}”`, error);
    } finally {
      writingRef.current = false;
      setSaving(false);
    }
  };

  const writeValue = async (rowIndex: number, column: string, valueJson: string) => {
    const ref = refForRow(rowIndex);
    if (!ref) return;
    try {
      const { value } = await unwrap(api.data.setDocumentField(ref, column, valueJson));
      applyPatch(rowIndex, column, value);
    } catch (error) {
      fail(`Could not update “${column}”`, error);
    }
  };

  const unsetValue = async (rowIndex: number, column: string) => {
    const ref = refForRow(rowIndex);
    if (!ref) return;
    try {
      await unwrap(api.data.unsetDocumentField(ref, column));
      applyPatch(rowIndex, column, undefined);
      store.pushToast({ kind: 'success', message: `Removed “${column}”` });
    } catch (error) {
      fail(`Could not remove “${column}”`, error);
    }
  };

  const duplicateRow = async (rowIndex: number) => {
    const ref = refForRow(rowIndex);
    if (!ref) return;
    try {
      await unwrap(api.data.duplicateDocument(ref));
      store.pushToast({ kind: 'success', message: 'Inserted a copy of the document' });
      edit?.onRefresh();
    } catch (error) {
      fail('Could not duplicate the document', error);
    }
  };

  const deleteRow = async (rowIndex: number, idJson: string) => {
    if (!edit) return;
    try {
      await unwrap(
        api.data.deleteDocument({
          connectionId: edit.connectionId,
          database: edit.database,
          collection: edit.collection,
          idJson
        })
      );
      selfWriteRef.current = true;
      edit.onRowRemoved(rowIndex);
      setSelected(null);
      store.pushToast({ kind: 'success', message: 'Deleted the document' });
    } catch (error) {
      fail('Could not delete the document', error);
    }
  };

  const askDelete = (rowIndex: number, idJson: string) => {
    if (store.settings?.confirmDestructiveOps === false) {
      void deleteRow(rowIndex, idJson);
      return;
    }
    setPendingDelete({ row: rowIndex, idJson });
  };

  const menuItems = (target: MenuState): MenuItem[] => {
    const row = rows[target.row];
    const idJson = idJsonOf(row);
    const column = target.column;
    const value = column ? row?.[column] : undefined;
    const inlineEditable = Boolean(edit && idJson && column && column !== '_id' && cellEditor(value));
    const literal = column ? shellLiteral(value) : null;
    const items: MenuItem[] = [];

    if (column && column !== '_id') {
      items.push({
        label: `Edit “${column}”`,
        hint: 'Enter',
        disabled: !inlineEditable,
        onSelect: () => startEdit(target.row, column)
      });
    }
    if (edit && idJson) {
      items.push({ label: 'Edit document…', onSelect: () => edit.onOpenDocument(idJson) });
    }
    items.push({ label: 'View document JSON', onSelect: () => setInspected(row) });
    if (column && value !== null && typeof value === 'object') {
      items.push({ label: `Inspect “${column}”`, onSelect: () => setInspected(value) });
    }

    items.push({ separator: true });
    if (column) {
      items.push({
        label: 'Copy value',
        hint: '⌘C',
        onSelect: () => void copy(clipboardText(value), 'the cell value')
      });
    }
    items.push({ label: 'Copy document', onSelect: () => void copy(prettyJson(row), 'the document') });
    if (idJson) {
      items.push({ label: 'Copy _id', onSelect: () => void copy(clipboardText(row?._id), 'the _id') });
    }

    if (edit && column && literal !== null) {
      items.push({ separator: true });
      items.push({
        label: 'Filter by this value',
        onSelect: () => edit.onFilterByValue(column, literal)
      });
    }

    if (edit && idJson) {
      items.push({ separator: true });
      if (column && column !== '_id') {
        items.push({
          label: 'Set to null',
          disabled: value === null,
          onSelect: () => void writeValue(target.row, column, 'null')
        });
        items.push({
          label: `Unset “${column}”`,
          disabled: value === undefined,
          onSelect: () => void unsetValue(target.row, column)
        });
      }
      items.push({ label: 'Duplicate document', onSelect: () => void duplicateRow(target.row) });
      items.push({
        label: 'Delete document…',
        danger: true,
        onSelect: () => askDelete(target.row, idJson)
      });
    }

    if (edit) {
      items.push({ separator: true });
      items.push({ label: 'Re-run the query', onSelect: edit.onRefresh });
    }
    return items;
  };

  const openMenu = (event: ReactMouseEvent, row: number, column: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (column) setSelected({ row, column });
    setMenu({ x: event.clientX, y: event.clientY, row, column });
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing || !selected) return;
    const columnIndex = columns.indexOf(selected.column);
    const move = (rowDelta: number, columnDelta: number) => {
      event.preventDefault();
      setSelected({
        row: Math.min(Math.max(selected.row + rowDelta, 0), rows.length - 1),
        column: columns[Math.min(Math.max(columnIndex + columnDelta, 0), columns.length - 1)]
      });
    };

    if (event.key === 'ArrowDown') move(1, 0);
    else if (event.key === 'ArrowUp') move(-1, 0);
    else if (event.key === 'ArrowRight') move(0, 1);
    else if (event.key === 'ArrowLeft') move(0, -1);
    else if (event.key === 'Escape') setSelected(null);
    else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      startEdit(selected.row, selected.column);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copy(clipboardText(rows[selected.row]?.[selected.column]), 'the cell value');
    }
  };

  const onEditorKeyDown = (active: EditState) => (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(active);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelledRef.current = true;
      setEditing(null);
      gridRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const nextColumn = columns[columns.indexOf(active.column) + (event.shiftKey ? -1 : 1)];
      void commit(active, nextColumn ? { row: active.row, column: nextColumn } : undefined);
    }
  };

  const onEditorBlur = (active: EditState) => () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    void commit(active);
  };

  const renderEditor = (active: EditState) => {
    if (active.kind === 'boolean') {
      return (
        <select
          className="cell-editor"
          autoFocus
          disabled={saving}
          title={cellEditHint(active.kind)}
          value={active.draft}
          onKeyDown={onEditorKeyDown(active)}
          onBlur={onEditorBlur(active)}
          onChange={(event) => {
            const draft = event.target.value;
            setEditing({ ...active, draft });
            void commit({ ...active, draft });
          }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    return (
      <input
        className="cell-editor"
        autoFocus
        spellCheck={false}
        disabled={saving}
        title={cellEditHint(active.kind)}
        value={active.draft}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onEditorKeyDown(active)}
        onBlur={onEditorBlur(active)}
        onChange={(event) => setEditing({ ...active, draft: event.target.value })}
      />
    );
  };

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
      <div className="table-wrap" ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 52 }}>#</th>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const idJson = idJsonOf(row);
              const editable = Boolean(edit && idJson);
              return (
                <tr key={index} className={menu?.row === index ? 'is-menu-target' : ''}>
                  <td
                    className="cell-index"
                    title={editable ? 'Edit this document' : undefined}
                    onClick={() => editable && edit?.onOpenDocument(idJson as string)}
                    onContextMenu={(event) => openMenu(event, index, null)}
                    style={editable ? { cursor: 'pointer' } : undefined}
                  >
                    {editable ? '✎ ' : ''}
                    {index + 1}
                  </td>
                  {columns.map((column) => {
                    const value = row?.[column];
                    const type = valueType(value);
                    const expandable = value !== null && typeof value === 'object';
                    const isSelected = selected?.row === index && selected.column === column;
                    const isEditing = editing?.row === index && editing.column === column;
                    return (
                      <td
                        key={column}
                        className={`${isSelected ? 'is-selected' : ''} ${isEditing ? 'is-editing' : ''}`}
                        title={
                          isEditing
                            ? undefined
                            : expandable
                              ? 'Double-click to inspect'
                              : formatCellValue(value)
                        }
                        onClick={() => {
                          if (!isEditing) setSelected({ row: index, column });
                        }}
                        onContextMenu={(event) => openMenu(event, index, column)}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          if (expandable) {
                            setInspected(value);
                            return;
                          }
                          startEdit(index, column);
                        }}
                      >
                        {isEditing && editing ? (
                          renderEditor(editing)
                        ) : (
                          <span className={`cell type-${type}`}>
                            {value === undefined ? '' : formatCellValue(value)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {inspected !== null ? (
        <Modal title="Document" onClose={() => setInspected(null)} width={760}>
          <pre className="json-view" style={{ padding: 0 }}>
            {prettyJson(inspected)}
          </pre>
        </Modal>
      ) : null}

      {pendingDelete ? (
        <Modal
          title="Delete document"
          onClose={() => setPendingDelete(null)}
          width={460}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  void deleteRow(target.row, target.idJson);
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            Row {pendingDelete.row + 1} will be removed from{' '}
            <span className="mono">
              {edit?.database}.{edit?.collection}
            </span>
            . This cannot be undone.
          </p>
        </Modal>
      ) : null}
    </>
  );
}
