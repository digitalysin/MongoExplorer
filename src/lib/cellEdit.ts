/**
 * Turns a relaxed-EJSON cell value into editable text and back into canonical
 * EJSON, so editing a cell in the result table cannot change its BSON type by
 * accident. Numbers stay plain JSON — the main process re-wraps them in the
 * numeric type the field already holds.
 */

export type CellEditKind =
  | 'string'
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'objectId'
  | 'date'
  | 'literal';

export interface CellEditor {
  kind: CellEditKind;
  /** The current value as text, ready for an input. */
  text: string;
}

/** Digits a double can hold exactly; past this an integer must travel as int64. */
const EXACT_INTEGER_DIGITS = 15;

/**
 * Describes how a value can be edited in place, or null when it belongs in the
 * JSON document editor instead (objects, arrays, binary, regex, timestamps).
 */
export function cellEditor(value: unknown): CellEditor | null {
  if (value === undefined) return { kind: 'literal', text: '' };
  if (value === null) return { kind: 'literal', text: 'null' };
  if (typeof value === 'string') return { kind: 'string', text: value };
  if (typeof value === 'number') return { kind: 'number', text: String(value) };
  if (typeof value === 'boolean') return { kind: 'boolean', text: String(value) };
  if (Array.isArray(value) || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  if (typeof record.$oid === 'string') return { kind: 'objectId', text: record.$oid };
  if (record.$date !== undefined) {
    const text = dateText(record.$date);
    return text === null ? null : { kind: 'date', text };
  }
  for (const key of ['$numberInt', '$numberLong', '$numberDouble'] as const) {
    if (record[key] !== undefined) return { kind: 'number', text: String(record[key]) };
  }
  if (record.$numberDecimal !== undefined) {
    return { kind: 'decimal', text: String(record.$numberDecimal) };
  }
  return null;
}

/** Canonical EJSON for edited text. Throws a message meant for the user. */
export function cellValueJson(kind: CellEditKind, text: string): string {
  const trimmed = text.trim();
  switch (kind) {
    case 'string':
      return JSON.stringify(text);
    case 'number':
      return numberJson(trimmed);
    case 'decimal':
      if (!isNumeric(trimmed)) throw new Error(`“${trimmed}” is not a number.`);
      return JSON.stringify({ $numberDecimal: trimmed });
    case 'boolean':
      return trimmed === 'true' ? 'true' : 'false';
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(trimmed)) {
        throw new Error('An ObjectId is 24 hexadecimal characters.');
      }
      return JSON.stringify({ $oid: trimmed.toLowerCase() });
    case 'date': {
      const millis = Date.parse(trimmed);
      if (!Number.isFinite(millis)) {
        throw new Error(`“${trimmed}” is not a date — try 2026-09-11 or 2026-09-11T09:17:52Z.`);
      }
      return JSON.stringify({ $date: new Date(millis).toISOString() });
    }
    case 'literal':
      return literalJson(trimmed);
  }
}

/** What the input should accept, shown as its tooltip. */
export function cellEditHint(kind: CellEditKind): string {
  switch (kind) {
    case 'string':
      return 'Text — saved as a string';
    case 'number':
      return 'A number — the field keeps its current numeric type';
    case 'decimal':
      return 'A decimal number, stored as NumberDecimal';
    case 'boolean':
      return 'true or false';
    case 'objectId':
      return '24 hexadecimal characters';
    case 'date':
      return 'A date such as 2026-09-11T09:17:52Z';
    case 'literal':
      return 'null, true/false, a number, JSON, or text';
  }
}

function dateText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  const millis = Number((raw as { $numberLong?: string })?.$numberLong ?? raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isNumeric(text: string): boolean {
  return text !== '' && Number.isFinite(Number(text));
}

function numberJson(text: string): string {
  if (!isNumeric(text)) throw new Error(`“${text}” is not a number.`);
  if (/^[+-]?\d+$/.test(text) && text.replace(/^[+-]/, '').length > EXACT_INTEGER_DIGITS) {
    return JSON.stringify({ $numberLong: text });
  }
  return String(Number(text));
}

/** Cells with no type to preserve (null or missing) infer one from the text. */
function literalJson(text: string): string {
  if (text === '') return '""';
  if (text === 'null' || text === 'true' || text === 'false') return text;
  if (isNumeric(text)) return numberJson(text);
  if (/^[{[]/.test(text)) {
    try {
      JSON.parse(text);
      return text;
    } catch (error) {
      throw new Error(`That is not valid JSON: ${(error as Error).message}`);
    }
  }
  return JSON.stringify(text);
}
