import type { Document } from 'mongodb';
import type { ProfilerSnapshot, RunningOperation, SlowOperation } from '../../shared/types.js';
import { getClient, getDb } from './pool.js';

/** A one-line version of a command document, for a table cell. */
function summarize(command: Document | undefined): string | null {
  if (!command || typeof command !== 'object') return null;
  const entries = Object.entries(command).filter(
    ([key]) => !key.startsWith('$') && key !== 'lsid' && key !== 'txnNumber'
  );
  if (entries.length === 0) return null;
  const text = entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${stringifyShort(value)}`)
    .join(', ');
  return `{ ${text}${entries.length > 4 ? ', …' : ''} }`;
}

function stringifyShort(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * Commands every driver sends to watch the topology. They are always in flight
 * and never the thing anyone is looking for.
 */
const MONITORING_COMMANDS = new Set([
  'hello',
  'ismaster',
  'ping',
  'buildinfo',
  'topologyversion',
  'replsetgetstatus',
  'serverstatus'
]);

function isMonitoring(entry: Document): boolean {
  const command = entry.command as Document | undefined;
  const name = command ? Object.keys(command)[0] ?? '' : '';
  return MONITORING_COMMANDS.has(name.toLowerCase());
}

function seconds(entry: Document): number | null {
  if (typeof entry.secs_running === 'number') return entry.secs_running;
  if (typeof entry.microsecs_running === 'number') return entry.microsecs_running / 1_000_000;
  return null;
}

function toOperation(entry: Document): RunningOperation {
  return {
    opid: String(entry.opid ?? ''),
    active: Boolean(entry.active),
    secondsRunning: seconds(entry),
    op: typeof entry.op === 'string' ? entry.op : (entry.desc as string) || null,
    namespace: typeof entry.ns === 'string' ? entry.ns : null,
    command: summarize(entry.command as Document | undefined),
    planSummary: typeof entry.planSummary === 'string' ? entry.planSummary : null,
    client: (entry.client as string) ?? (entry.client_s as string) ?? null,
    appName: (entry.appName as string) || null,
    waitingForLock: Boolean(entry.waitingForLock),
    description: typeof entry.desc === 'string' ? entry.desc : null
  };
}

/**
 * What the deployment is doing right now. `$currentOp` is the modern way in and
 * needs the `inprog` privilege; where that is unavailable — an older server, or
 * a user without it — the classic command still answers.
 */
export async function currentOperations(
  connectionId: string,
  options: { includeIdle?: boolean } = {}
): Promise<RunningOperation[]> {
  const admin = getClient(connectionId).db('admin');
  const stage = {
    $currentOp: {
      allUsers: true,
      idleConnections: Boolean(options.includeIdle),
      idleSessions: Boolean(options.includeIdle),
      localOps: false
    }
  };

  let entries: Document[];
  try {
    entries = await admin.aggregate([stage]).toArray();
  } catch {
    const result = await admin.command({
      currentOp: 1,
      $all: Boolean(options.includeIdle)
    });
    entries = (result.inprog as Document[]) ?? [];
  }

  return entries
    .filter((entry) => entry.opid !== undefined && (options.includeIdle || !isMonitoring(entry)))
    .map(toOperation)
    // A connection sitting there with no operation on it is not something
    // anyone is hunting, so it only shows when idle entries are asked for.
    .filter((operation) => options.includeIdle || (operation.active && operation.op !== 'none'))
    // The longest-running operation is the one worth looking at first.
    .sort((a, b) => (b.secondsRunning ?? 0) - (a.secondsRunning ?? 0));
}

/** Stops one operation. The id is passed through as the server reported it. */
export async function killOperation(connectionId: string, opid: string): Promise<void> {
  const op = /^\d+$/.test(opid) ? Number(opid) : opid;
  const result = await getClient(connectionId).db('admin').command({ killOp: 1, op });
  if (result.ok !== 1) throw new Error(`The server would not stop operation ${opid}.`);
}

function toSlowOperation(entry: Document): SlowOperation {
  const at = entry.ts instanceof Date ? entry.ts.toISOString() : new Date().toISOString();
  return {
    at,
    millis: typeof entry.millis === 'number' ? entry.millis : 0,
    op: typeof entry.op === 'string' ? entry.op : null,
    namespace: typeof entry.ns === 'string' ? entry.ns : null,
    planSummary: typeof entry.planSummary === 'string' ? entry.planSummary : null,
    command: summarize(entry.command as Document | undefined),
    documentsExamined: typeof entry.docsExamined === 'number' ? entry.docsExamined : null,
    keysExamined: typeof entry.keysExamined === 'number' ? entry.keysExamined : null,
    returned: typeof entry.nreturned === 'number' ? entry.nreturned : null
  };
}

/**
 * The profiler's settings and whatever it has recorded. Profiling is per
 * database and off by default, so an empty list usually means nobody turned it
 * on rather than nothing being slow.
 */
export async function profilerSnapshot(
  connectionId: string,
  database: string,
  limit = 50
): Promise<ProfilerSnapshot> {
  const db = getDb(connectionId, database);
  const status = await db.command({ profile: -1 });
  const level = typeof status.was === 'number' ? status.was : 0;
  const slowMs = typeof status.slowms === 'number' ? status.slowms : 100;

  if (level === 0) {
    return { database, level, slowMs, operations: [] };
  }

  const entries = await db
    .collection('system.profile')
    .find({}, { sort: { ts: -1 }, limit: Math.min(Math.max(limit, 1), 200) })
    .toArray()
    .catch(() => [] as Document[]);

  return { database, level, slowMs, operations: entries.map(toSlowOperation) };
}
