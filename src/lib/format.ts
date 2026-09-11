const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), 5);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : value >= 100 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Renders a relaxed-EJSON value the way a Mongo GUI should: BSON wrappers become
 * their familiar shell notation, everything else falls back to compact JSON.
 */
export function formatCellValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[ ${value.length} ${value.length === 1 ? 'item' : 'items'} ]`;

  const record = value as Record<string, unknown>;
  const bson = describeBson(record);
  if (bson !== null) return bson;

  const keys = Object.keys(record);
  return `{ ${keys.length} ${keys.length === 1 ? 'field' : 'fields'} }`;
}

/** Returns shell notation for an EJSON wrapper, or null when it is a plain object. */
export function describeBson(record: Record<string, unknown>): string | null {
  if (typeof record.$oid === 'string') return `ObjectId("${record.$oid}")`;
  if (record.$date !== undefined) {
    const raw = record.$date;
    const iso =
      typeof raw === 'string'
        ? raw
        : new Date(Number((raw as { $numberLong?: string })?.$numberLong ?? raw)).toISOString();
    return `ISODate("${iso}")`;
  }
  if (record.$numberLong !== undefined) return String(record.$numberLong);
  if (record.$numberInt !== undefined) return String(record.$numberInt);
  if (record.$numberDouble !== undefined) return String(record.$numberDouble);
  if (record.$numberDecimal !== undefined) return `NumberDecimal("${String(record.$numberDecimal)}")`;
  if (record.$binary !== undefined) return 'BinData(…)';
  if (record.$timestamp !== undefined) {
    const ts = record.$timestamp as { t?: number; i?: number };
    return `Timestamp(${ts?.t ?? 0}, ${ts?.i ?? 0})`;
  }
  if (record.$regularExpression !== undefined) {
    const regex = record.$regularExpression as { pattern?: string; options?: string };
    return `/${regex?.pattern ?? ''}/${regex?.options ?? ''}`;
  }
  if (record.$minKey !== undefined) return 'MinKey';
  if (record.$maxKey !== undefined) return 'MaxKey';
  if (record.$undefined !== undefined) return 'undefined';
  return null;
}

/**
 * Renders a relaxed-EJSON value as a literal that can be pasted into the query
 * editor, or null for values no shell literal can express (binary, timestamps).
 */
export function shellLiteral(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);

  const record = value as Record<string, unknown>;
  if (typeof record.$oid === 'string') return `ObjectId("${record.$oid}")`;
  if (record.$date !== undefined) return describeBson(record);
  if (record.$numberLong !== undefined) return `NumberLong("${String(record.$numberLong)}")`;
  if (record.$numberDecimal !== undefined) {
    return `NumberDecimal("${String(record.$numberDecimal)}")`;
  }
  if (record.$numberInt !== undefined || record.$numberDouble !== undefined) {
    return describeBson(record);
  }
  if (describeBson(record) !== null) return null;
  return JSON.stringify(value);
}

export function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') {
    const described = describeBson(value as Record<string, unknown>);
    if (described) {
      if (described.startsWith('ObjectId')) return 'objectId';
      if (described.startsWith('ISODate')) return 'date';
      if (described.startsWith('NumberDecimal')) return 'decimal';
      if (described.startsWith('BinData')) return 'binary';
      return 'bson';
    }
    return 'object';
  }
  return typeof value;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function describeIndexKeys(keys: Record<string, unknown>): string {
  return Object.entries(keys)
    .map(([field, direction]) => {
      if (direction === 1) return `${field} ↑`;
      if (direction === -1) return `${field} ↓`;
      return `${field}: ${String(direction)}`;
    })
    .join(', ');
}
