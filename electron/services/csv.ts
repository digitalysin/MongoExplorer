/** Minimal RFC 4180 CSV helpers — no third-party dependency needed. */

export function encodeCsvValue(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value as string | number | boolean);
  const needsQuoting =
    text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r');
  return needsQuoting ? `"${text.replace(/"/g, '""')}"` : text;
}

export function encodeCsvRow(values: unknown[], delimiter: string): string {
  return values.map((value) => encodeCsvValue(value, delimiter)).join(delimiter);
}

/**
 * Incremental CSV parser: feed it chunks, get back complete rows. Quoted
 * fields may contain the delimiter, quotes ("") and newlines.
 */
export class CsvRowParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private quoteJustClosed = false;
  private pendingCarriageReturn = false;

  constructor(private readonly delimiter: string) {}

  push(chunk: string): string[][] {
    const rows: string[][] = [];
    for (const char of chunk) {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false;
        if (char === '\n') continue;
      }

      if (this.inQuotes) {
        if (this.quoteJustClosed) {
          this.quoteJustClosed = false;
          if (char === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
          // fall through so the character is handled as unquoted content
        } else if (char === '"') {
          this.quoteJustClosed = true;
          continue;
        } else {
          this.field += char;
          continue;
        }
      }

      if (char === '"' && this.field === '') {
        this.inQuotes = true;
      } else if (char === this.delimiter) {
        this.row.push(this.field);
        this.field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r') this.pendingCarriageReturn = true;
        this.row.push(this.field);
        this.field = '';
        rows.push(this.row);
        this.row = [];
      } else {
        this.field += char;
      }
    }
    return rows;
  }

  flush(): string[][] {
    if (this.inQuotes && this.quoteJustClosed) this.inQuotes = false;
    if (this.field.length > 0 || this.row.length > 0) {
      this.row.push(this.field);
      const row = this.row;
      this.field = '';
      this.row = [];
      return [row];
    }
    return [];
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Best-effort typing for CSV cells, mirroring mongoimport's default behaviour. */
export function coerceCsvValue(raw: string, inferTypes: boolean): unknown {
  if (raw === '') return null;
  if (!inferTypes) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) {
    const asNumber = Number(raw);
    return Number.isSafeInteger(asNumber) ? asNumber : raw;
  }
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(raw)) return Number(raw);
  if (ISO_DATE.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return raw;
}

/** Expands `a.b.c` headers into nested objects, like mongoimport. */
export function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments.at(-1) as string] = value;
}

/** Flattens a document into dot-paths so it can be written as CSV columns. */
export function flattenDocument(
  value: unknown,
  prefix = '',
  out: Record<string, unknown> = {}
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isBsonLike(value)) {
    out[prefix || 'value'] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child) && !isBsonLike(child)) {
      flattenDocument(child, path, out);
    } else {
      out[path] = child;
    }
  }
  return out;
}

/** EJSON wrappers such as `{ $oid: ... }` are leaf values, not nested objects. */
function isBsonLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}
