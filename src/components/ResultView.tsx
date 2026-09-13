import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { DocumentRef, QueryResult } from '../../shared/types';
import { api, unwrap } from '../lib/api';
import { cellEditHint, cellEditor, cellValueJson, type CellEditKind } from '../lib/cellEdit';
import { formatCellValue, prettyJson, shellLiteral, valueType } from '../lib/format';
import { useStore } from '../state/store';
import {
  Button,
  ContextMenu,
  EmptyState,
  Field,
  Modal,
  Select,
  TextInput,
  TypeToConfirm,
  type MenuItem
} from './ui';

export type ResultMode = 'table' | 'json';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Names one cell, for telling a cancelled edit from the next one. */
const cellKey = (cell: CellRef) => `${cell.row}:${cell.column}`;

/** One running confirmation for cell saves, rather than a pile of toasts. */
const SAVE_TOAST = 'cell-save';

/** Everything the table needs to write back to the collection it came from. */
export interface ResultEditContext {
  connectionId: string;
  database: string;
  collection: string;
  /** Opens the full document in the JSON editor. */
  onOpenDocument: (idJson: string) => void;
  /** Repaints one cell after a confirmed write; `undefined` drops the field. */
  onRowPatch: (rowIndex: number, field: string, value: unknown) => void;
  /** The same, for a whole selection, applied in one go. */
  onRowsPatch: (patches: Array<{ row: number; field: string; value: unknown }>) => void;
  onRowsRemoved: (rowIndexes: number[]) => void;
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
  edit,
  rowOffset = 0
}: {
  result: QueryResult;
  mode: ResultMode;
  /** Absent when the result is not tied to a single editable collection. */
  edit?: ResultEditContext;
  /** Documents skipped before this page, so the row numbers keep counting. */
  rowOffset?: number;
}) {
  const store = useStore();
  const [inspected, setInspected] = useState<unknown>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  // Where a range selection started; the selected cell is its other corner.
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCells, setSavedCells] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ rows: number[]; idsJson: string[] } | null>(
    null
  );
  const [bulkEdit, setBulkEdit] = useState<{ column: string; kind: CellEditKind; draft: string } | null>(
    null
  );
  const [confirmText, setConfirmText] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Escape can unmount the input before its blur arrives, so the cancelled
  // cell is remembered by name: a stale flag would swallow the next cell's save.
  const cancelledRef = useRef<string | null>(null);
  // Enter commits and unmounts the input, whose blur would otherwise write twice.
  const writingRef = useRef(false);
  // Distinguishes rows we just wrote ourselves from a freshly run query.
  const selfWriteRef = useRef(false);

  const rows = useMemo(
    () => result.documents as Array<Record<string, unknown>>,
    [result.documents]
  );
  const columns = result.columns;

  // Whatever is being edited, reachable from teardown paths that have no
  // access to render state: an unmount, a re-run, a switch to JSON.
  const pendingRef = useRef<EditState | null>(null);
  pendingRef.current = editing;
  const commitRef = useRef<((active: EditState, options?: CommitOptions) => Promise<void>) | null>(
    null
  );

  /**
   * Writes an edit that is about to lose its editor. Focus changes already
   * commit through blur; this covers everything that removes the input without
   * one — re-running the query, leaving the table, closing the tab.
   */
  const flushPending = useCallback(() => {
    const active = pendingRef.current;
    if (!active || active.draft === active.initial) return;
    pendingRef.current = null;
    void commitRef.current?.(active, { keepOpen: true });
  }, []);

  // A new set of documents means the rows under the cursor moved.
  useEffect(() => {
    if (selfWriteRef.current) {
      selfWriteRef.current = false;
      return;
    }
    flushPending();
    setEditing(null);
    setSelected(null);
    setAnchor(null);
    setMenu(null);
  }, [flushPending, rows]);

  // Leaving the table for the JSON view, or closing the tab altogether.
  useEffect(() => {
    if (mode !== 'table') flushPending();
  }, [flushPending, mode]);

  useEffect(
    () => () => {
      flushPending();
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [flushPending]
  );

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

  /** The rectangle between the anchor and the selected cell. */
  const range = useMemo(() => {
    if (!selected) return null;
    const other = anchor ?? selected;
    const selectedIndex = columns.indexOf(selected.column);
    const otherIndex = columns.indexOf(other.column);
    if (selectedIndex < 0 || otherIndex < 0) return null;
    const rowFrom = Math.min(selected.row, other.row);
    const rowTo = Math.max(selected.row, other.row);
    const from = Math.min(selectedIndex, otherIndex);
    const to = Math.max(selectedIndex, otherIndex);
    return {
      rowFrom,
      rowTo,
      columnFrom: from,
      columnTo: to,
      rowIndexes: Array.from({ length: rowTo - rowFrom + 1 }, (_, offset) => rowFrom + offset),
      columns: columns.slice(from, to + 1)
    };
  }, [anchor, columns, selected]);

  const inRange = (row: number, column: string) => {
    if (!range) return false;
    const index = columns.indexOf(column);
    return (
      row >= range.rowFrom &&
      row <= range.rowTo &&
      index >= range.columnFrom &&
      index <= range.columnTo
    );
  };

  const cellsInRange = range ? range.rowIndexes.length * range.columns.length : 0;
  /** A selection worth acting on as a batch rather than as one cell. */
  const multi = cellsInRange > 1;
  /** Documents the selection covers, in the order the table shows them. */
  const selectedRows = range
    ? range.rowIndexes.filter((row) => idJsonOf(rows[row]) !== null)
    : [];
  const selectedIdsJson = selectedRows.map((row) => idJsonOf(rows[row]) as string);
  /** The one column a range covers, or null when it spans several. */
  const singleColumn = range && range.columns.length === 1 ? range.columns[0] : null;

  const selectCell = (cell: CellRef, extend: boolean) => {
    if (extend && selected) setSelected(cell);
    else {
      setAnchor(cell);
      setSelected(cell);
    }
  };

  /** Selects whole documents, which is what the row-number column is for. */
  const selectRow = (row: number, extend: boolean) => {
    const first = columns[0];
    const last = columns[columns.length - 1];
    if (!first || !last) return;
    setAnchor({ row: extend && anchor ? anchor.row : row, column: first });
    setSelected({ row, column: last });
    setEditing(null);
  };

  /** Applies a confirmed write without letting it clear the cursor. */
  const applyPatch = (rowIndex: number, field: string, value: unknown) => {
    selfWriteRef.current = true;
    edit?.onRowPatch(rowIndex, field, value);
  };

  const hint = (message: string) => store.pushToast({ kind: 'info', message });

  /** Confirms the write where the user is looking, not only in the corner. */
  const markSaved = (row: number, column: string) => markManySaved([{ row, column }]);

  const markManySaved = (cells: CellRef[]) => {
    setSavedCells(cells.map(cellKey));
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedCells([]), 1400);
  };

  const copy = async (text: string, label: string) => {
    try {
      await unwrap(api.app.copyToClipboard(text));
      store.notify(`Copied ${label}`);
    } catch (error) {
      store.reportError('Could not copy to the clipboard', error);
    }
  };

  const startEdit = (rowIndex: number, column: string) => {
    if (!edit) return;
    if (column === '_id') {
      hint('The _id of an existing document cannot be changed.');
      return;
    }
    const idJson = idJsonOf(rows[rowIndex]);
    if (!idJson) {
      hint('This row has no _id, so it cannot be edited in place.');
      return;
    }
    const editor = cellEditor(rows[rowIndex]?.[column]);
    if (!editor) {
      hint(`“${column}” holds a value that needs the document editor.`);
      return;
    }
    cancelledRef.current = null;
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

  interface CommitOptions {
    /** Opens the editor here once the write lands, for Tab. */
    next?: CellRef;
    /** Keeps the editor open and focused, for an explicit ⌘S. */
    keepOpen?: boolean;
    /**
     * Returns focus to the grid. Only for keyboard commits: after a blur the
     * user has already clicked somewhere, and taking that focus back once the
     * write resolves would be rude.
     */
    refocus?: boolean;
  }

  /** Writes the edited cell, then optionally opens the editor on another cell. */
  const commit = async (active: EditState, options: CommitOptions = {}) => {
    if (writingRef.current) return;
    const ref = refFor(active.idJson);
    if (!ref) return;

    const moveOn = () => {
      if (options.keepOpen) return;
      setEditing(null);
      if (options.next) startEdit(options.next.row, options.next.column);
      else if (options.refocus) gridRef.current?.focus();
    };

    if (active.draft === active.initial) {
      moveOn();
      return;
    }

    let valueJson: string;
    try {
      valueJson = cellValueJson(active.kind, active.draft);
    } catch (error) {
      // The editor stays open on invalid input so the value can be fixed.
      store.reportError(`“${active.column}” cannot hold that value`, error);
      return;
    }

    // What is about to be stored, remembered before the await: the user may
    // type on while the write is in flight.
    const written = active.draft;
    writingRef.current = true;
    setSaving(true);
    try {
      const { value } = await unwrap(api.data.setDocumentField(ref, active.column, valueJson));
      applyPatch(active.row, active.column, value);
      // The editor now agrees with the collection, so a further keystroke
      // counts as a new change rather than a re-save of this one.
      setEditing((current) =>
        current && current.row === active.row && current.column === active.column
          ? { ...current, initial: written }
          : current
      );
      markSaved(active.row, active.column);
      store.notify(`Saved “${active.column}”`, SAVE_TOAST);
      moveOn();
    } catch (error) {
      store.reportError(`Could not update “${active.column}”`, error);
    } finally {
      writingRef.current = false;
      setSaving(false);
    }
  };

  commitRef.current = commit;

  const writeValue = async (rowIndex: number, column: string, valueJson: string) => {
    const ref = refForRow(rowIndex);
    if (!ref) return;
    try {
      const { value } = await unwrap(api.data.setDocumentField(ref, column, valueJson));
      applyPatch(rowIndex, column, value);
      store.notify(`Updated “${column}”`);
    } catch (error) {
      store.reportError(`Could not update “${column}”`, error);
    }
  };

  // A production connection asks for the collection name before a batch write.
  const needsTypedConfirm =
    Boolean(edit) &&
    store.connections.find((connection) => connection.id === edit?.connectionId)?.environment ===
      'production';

  /** The selection as tab-separated text, which is what spreadsheets paste. */
  const rangeText = () => {
    if (!range) return '';
    const flat = (value: unknown) => clipboardText(value).replace(/[\t\r\n]+/g, ' ');
    return range.rowIndexes
      .map((row) => range.columns.map((column) => flat(rows[row]?.[column])).join('\t'))
      .join('\n');
  };

  const openBulkEdit = (column: string) => {
    const source = rows[selected?.row ?? range?.rowFrom ?? 0]?.[column];
    const editor = cellEditor(source);
    if (!editor) {
      hint(`“${column}” holds a value that needs the document editor.`);
      return;
    }
    setConfirmText('');
    setBulkEdit({ column, kind: editor.kind, draft: editor.text });
  };

  const applyBulkEdit = async (active: { column: string; kind: CellEditKind; draft: string }) => {
    let valueJson: string;
    try {
      valueJson = cellValueJson(active.kind, active.draft);
    } catch (error) {
      store.reportError(`“${active.column}” cannot hold that value`, error);
      return;
    }
    setBulkEdit(null);
    await writeManyValues(active.column, valueJson);
  };

  const bulkTarget = () => {
    if (!edit || selectedIdsJson.length === 0) return null;
    return {
      connectionId: edit.connectionId,
      database: edit.database,
      collection: edit.collection,
      idsJson: selectedIdsJson
    };
  };

  /** Writes one value across every document the selection covers. */
  const writeManyValues = async (column: string, valueJson: string) => {
    const target = bulkTarget();
    if (!target) return;
    const rowByIdJson = new Map(selectedRows.map((row) => [idJsonOf(rows[row]) as string, row]));
    setSaving(true);
    try {
      const result = await unwrap(api.data.setFieldOnMany({ ...target, field: column, valueJson }));
      const patches = result.updates
        .map((update) => ({ row: rowByIdJson.get(update.idJson), value: update.value }))
        .filter((patch): patch is { row: number; value: unknown } => patch.row !== undefined)
        .map((patch) => ({ row: patch.row, field: column, value: patch.value }));
      selfWriteRef.current = true;
      edit?.onRowsPatch(patches);
      markManySaved(patches.map((patch) => ({ row: patch.row, column })));
      store.notify(
        `Saved “${column}” on ${result.modified} of ${plural(result.matched, 'document')}`,
        SAVE_TOAST
      );
    } catch (error) {
      store.reportError(`Could not update “${column}” on the selected documents`, error);
    } finally {
      setSaving(false);
    }
  };

  const unsetManyValues = async (column: string) => {
    const target = bulkTarget();
    if (!target) return;
    const affected = [...selectedRows];
    try {
      const result = await unwrap(api.data.unsetFieldOnMany({ ...target, field: column }));
      selfWriteRef.current = true;
      edit?.onRowsPatch(affected.map((row) => ({ row, field: column, value: undefined })));
      markManySaved(affected.map((row) => ({ row, column })));
      store.notify(
        `Removed “${column}” from ${plural(result.modified, 'document')}`,
        SAVE_TOAST
      );
    } catch (error) {
      store.reportError(`Could not remove “${column}” from the selected documents`, error);
    }
  };

  const deleteRows = async (rowIndexes: number[], idsJson: string[]) => {
    if (!edit) return;
    try {
      const result = await unwrap(
        api.data.deleteDocuments({
          connectionId: edit.connectionId,
          database: edit.database,
          collection: edit.collection,
          idsJson
        })
      );
      selfWriteRef.current = true;
      edit.onRowsRemoved(rowIndexes);
      setSelected(null);
      setAnchor(null);
      store.notify(`Deleted ${plural(result.deleted, 'document')}`);
    } catch (error) {
      store.reportError('Could not delete the selected documents', error);
    }
  };

  const unsetValue = async (rowIndex: number, column: string) => {
    const ref = refForRow(rowIndex);
    if (!ref) return;
    try {
      await unwrap(api.data.unsetDocumentField(ref, column));
      applyPatch(rowIndex, column, undefined);
      store.notify(`Removed “${column}”`);
    } catch (error) {
      store.reportError(`Could not remove “${column}”`, error);
    }
  };

  const duplicateRow = async (rowIndex: number) => {
    const ref = refForRow(rowIndex);
    if (!ref) return;
    try {
      await unwrap(api.data.duplicateDocument(ref));
      store.notify('Inserted a copy of the document');
      edit?.onRefresh();
    } catch (error) {
      store.reportError('Could not duplicate the document', error);
    }
  };

  const askDelete = (rowIndexes: number[], idsJson: string[]) => {
    if (store.settings?.confirmDestructiveOps === false && !needsTypedConfirm) {
      void deleteRows(rowIndexes, idsJson);
      return;
    }
    setConfirmText('');
    setPendingDelete({ rows: rowIndexes, idsJson });
  };

  const batchMenuItems = (): MenuItem[] => {
    const documents = selectedIdsJson.length;
    const items: MenuItem[] = [];
    if (edit && documents > 0 && singleColumn && singleColumn !== '_id') {
      items.push({
        label: `Set “${singleColumn}” on ${plural(documents, 'document')}…`,
        onSelect: () => openBulkEdit(singleColumn)
      });
      items.push({
        label: `Set to null on ${plural(documents, 'document')}`,
        onSelect: () => void writeManyValues(singleColumn, 'null')
      });
      items.push({
        label: `Unset “${singleColumn}” on ${plural(documents, 'document')}`,
        onSelect: () => void unsetManyValues(singleColumn)
      });
      items.push({ separator: true });
    }
    items.push({
      label: `Copy ${plural(cellsInRange, 'cell')}`,
      hint: '⌘C',
      onSelect: () => void copy(rangeText(), 'the selected cells')
    });
    items.push({
      label: `Copy ${plural(documents, 'document')}`,
      disabled: documents === 0,
      onSelect: () =>
        void copy(prettyJson(selectedRows.map((row) => rows[row])), 'the selected documents')
    });
    if (edit && documents > 0) {
      items.push({ separator: true });
      items.push({
        label: `Delete ${plural(documents, 'document')}…`,
        danger: true,
        onSelect: () => askDelete(selectedRows, selectedIdsJson)
      });
    }
    if (edit) {
      items.push({ separator: true });
      items.push({ label: 'Re-run the query', onSelect: edit.onRefresh });
    }
    return items;
  };

  const menuItems = (target: MenuState): MenuItem[] => {
    if (multi) return batchMenuItems();
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
        onSelect: () => askDelete([target.row], [idJson])
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
    // A right-click inside the selection acts on it; outside it, it starts anew.
    if (column && !inRange(row, column)) selectCell({ row, column }, false);
    else if (!column && !range?.rowIndexes.includes(row)) selectRow(row, false);
    setMenu({ x: event.clientX, y: event.clientY, row, column });
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      // Nothing is open, so nothing can be unsaved — say so rather than
      // leaving the user wondering whether the keystroke did anything.
      event.preventDefault();
      if (edit) {
        store.pushToast({
          kind: 'info',
          message: 'Every change is already saved',
          key: SAVE_TOAST
        });
      }
      return;
    }
    if (editing || !selected) return;
    const columnIndex = columns.indexOf(selected.column);
    // Shift keeps the anchor where it is, which is how a range grows.
    const move = (rowDelta: number, columnDelta: number) => {
      event.preventDefault();
      const cell = {
        row: Math.min(Math.max(selected.row + rowDelta, 0), rows.length - 1),
        column: columns[Math.min(Math.max(columnIndex + columnDelta, 0), columns.length - 1)]
      };
      selectCell(cell, event.shiftKey);
    };

    if (event.key === 'ArrowDown') move(1, 0);
    else if (event.key === 'ArrowUp') move(-1, 0);
    else if (event.key === 'ArrowRight') move(0, 1);
    else if (event.key === 'ArrowLeft') move(0, -1);
    else if (event.key === 'Escape') {
      setSelected(null);
      setAnchor(null);
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      startEdit(selected.row, selected.column);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (multi) void copy(rangeText(), `${plural(cellsInRange, 'cell')}`);
      else void copy(clipboardText(rows[selected.row]?.[selected.column]), 'the cell value');
    }
  };

  const onEditorKeyDown = (active: EditState) => (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      // An explicit save leaves the editor where it is, so editing can carry on.
      event.preventDefault();
      void commit(active, { keepOpen: true });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(active, { refocus: true });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelledRef.current = cellKey(active);
      setEditing(null);
      gridRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const nextColumn = columns[columns.indexOf(active.column) + (event.shiftKey ? -1 : 1)];
      void commit(active, {
        next: nextColumn ? { row: active.row, column: nextColumn } : undefined,
        refocus: true
      });
    }
  };

  const onEditorBlur = (active: EditState) => () => {
    if (cancelledRef.current === cellKey(active)) {
      cancelledRef.current = null;
      return;
    }
    // Leaving the cell is a save. The focus has already gone somewhere else, so
    // the write must not pull it back.
    void commit(active);
  };

  const renderEditor = (active: EditState) => {
    if (active.kind === 'boolean') {
      return (
        <select
          className={`cell-editor ${saving ? 'is-saving' : ''}`}
          autoFocus
          ref={(node) => {
            editorRef.current = node;
          }}
          title={cellEditHint(active.kind)}
          value={active.draft}
          onKeyDown={onEditorKeyDown(active)}
          onBlur={onEditorBlur(active)}
          onChange={(event) => {
            const draft = event.target.value;
            setEditing({ ...active, draft });
            void commit({ ...active, draft }, { refocus: true });
          }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    return (
      <input
        className={`cell-editor ${saving ? 'is-saving' : active.draft === active.initial ? '' : 'is-dirty'}`}
        autoFocus
        spellCheck={false}
        ref={(node) => {
          editorRef.current = node;
        }}
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
                    className={`cell-index ${
                      range?.rowIndexes.includes(index) && range.columns.length === columns.length
                        ? 'is-selected'
                        : ''
                    }`}
                    title={
                      editable
                        ? 'Click to edit this document · ⌘-click or shift-click to select rows'
                        : undefined
                    }
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey) {
                        selectRow(index, event.shiftKey);
                        return;
                      }
                      if (editable) edit?.onOpenDocument(idJson as string);
                    }}
                    onContextMenu={(event) => openMenu(event, index, null)}
                    style={editable ? { cursor: 'pointer' } : undefined}
                  >
                    {editable ? '✎ ' : ''}
                    {rowOffset + index + 1}
                  </td>
                  {columns.map((column) => {
                    const value = row?.[column];
                    const type = valueType(value);
                    const expandable = value !== null && typeof value === 'object';
                    const isSelected = inRange(index, column);
                    const isFocus = selected?.row === index && selected.column === column;
                    const isEditing = editing?.row === index && editing.column === column;
                    const justSaved = savedCells.includes(cellKey({ row: index, column }));
                    return (
                      <td
                        key={column}
                        className={`${isSelected ? 'is-selected' : ''} ${
                          isFocus ? 'is-focus' : ''
                        } ${isEditing ? 'is-editing' : ''} ${justSaved ? 'is-saved' : ''}`}
                        title={
                          isEditing
                            ? undefined
                            : expandable
                              ? 'Double-click to inspect'
                              : formatCellValue(value)
                        }
                        onClick={(event) => {
                          if (isEditing) return;
                          selectCell({ row: index, column }, event.shiftKey);
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

      {multi ? (
        <div className="selection-bar">
          <strong>{plural(cellsInRange, 'cell')}</strong> selected across{' '}
          <strong>{plural(selectedIdsJson.length, 'document')}</strong>
          <span className="spacer" />
          <span className="dim">
            ⌘C copies the selection · right-click to edit or delete them together
          </span>
        </div>
      ) : null}

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

      {bulkEdit ? (
        <Modal
          title={`Set “${bulkEdit.column}” on ${plural(selectedIdsJson.length, 'document')}`}
          subtitle={cellEditHint(bulkEdit.kind)}
          onClose={() => setBulkEdit(null)}
          width={460}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setBulkEdit(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={saving || (needsTypedConfirm && confirmText !== edit?.collection)}
                onClick={() => void applyBulkEdit(bulkEdit)}
              >
                {`Set on ${plural(selectedIdsJson.length, 'document')}`}
              </Button>
            </>
          }
        >
          <Field
            label={bulkEdit.column}
            hint={`Written with one $set across ${plural(selectedIdsJson.length, 'document')}.${
              bulkEdit.kind === 'number'
                ? ' Each document keeps the numeric type its field already holds.'
                : ''
            }`}
          >
            {bulkEdit.kind === 'boolean' ? (
              <Select
                value={bulkEdit.draft}
                onChange={(event) => setBulkEdit({ ...bulkEdit, draft: event.target.value })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </Select>
            ) : (
              <TextInput
                autoFocus
                spellCheck={false}
                value={bulkEdit.draft}
                onChange={(event) => setBulkEdit({ ...bulkEdit, draft: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !needsTypedConfirm) void applyBulkEdit(bulkEdit);
                }}
              />
            )}
          </Field>
          {needsTypedConfirm ? (
            <TypeToConfirm
              word={edit?.collection ?? ''}
              value={confirmText}
              onChange={setConfirmText}
            />
          ) : null}
        </Modal>
      ) : null}

      {pendingDelete ? (
        <Modal
          title={pendingDelete.idsJson.length === 1 ? 'Delete document' : 'Delete documents'}
          onClose={() => setPendingDelete(null)}
          width={460}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={needsTypedConfirm && confirmText !== edit?.collection}
                onClick={() => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  void deleteRows(target.rows, target.idsJson);
                }}
              >
                {pendingDelete.idsJson.length === 1
                  ? 'Delete'
                  : `Delete ${plural(pendingDelete.idsJson.length, 'document')}`}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            {pendingDelete.idsJson.length === 1
              ? `Row ${rowOffset + pendingDelete.rows[0] + 1} will be removed from `
              : `${plural(pendingDelete.idsJson.length, 'document')} will be removed from `}
            <span className="mono">
              {edit?.database}.{edit?.collection}
            </span>
            . This cannot be undone.
          </p>
          {needsTypedConfirm ? (
            <TypeToConfirm
              word={edit?.collection ?? ''}
              value={confirmText}
              onChange={setConfirmText}
            />
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
