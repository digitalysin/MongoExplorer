import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Document } from 'mongodb';
import type {
  MongoToolName,
  ToolBatchRequest,
  ToolDetection,
  ToolRunRequest,
  TransferPart,
  TransferProgress,
  TransferResult
} from '../../shared/types.js';
import { EJSON } from './bsonEval.js';
import { buildConnectionUri, getConnection, resolveSecrets } from './connections.js';
import { getDb } from './pool.js';
import { loadSettings } from './store.js';
import { exportableCollections, safeFileName } from './transfer.js';

const TOOL_NAMES: MongoToolName[] = [
  'mongodump',
  'mongorestore',
  'mongoexport',
  'mongoimport',
  'mongosh'
];

/** Where the MongoDB Database Tools usually land per platform. */
function commonLocations(tool: MongoToolName): string[] {
  const executable = process.platform === 'win32' ? `${tool}.exe` : tool;
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const candidates: string[] = [];
    for (const version of ['100', '110']) {
      candidates.push(path.join(programFiles, 'MongoDB', 'Tools', version, 'bin', executable));
    }
    candidates.push(path.join(programFiles, 'MongoDB', 'Server', 'bin', executable));
    candidates.push(path.join(programFiles, 'mongosh', executable));
    return candidates;
  }
  const bases = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/opt/mongodb/bin',
    '/snap/bin',
    path.join(os.homedir(), '.local', 'bin')
  ];
  return bases.map((base) => path.join(base, executable));
}

function whichSync(tool: MongoToolName): string | null {
  const executable = process.platform === 'win32' ? `${tool}.exe` : tool;
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, executable);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(candidate: string): boolean {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readVersion(executable: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5000);
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = output.match(/(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : output.split('\n')[0]?.trim() || null);
    });
  });
}

/**
 * Resolves each tool from (1) the path configured in Settings, (2) PATH, and
 * (3) the usual install locations. Nothing here is required for the app to
 * work — the native import/export never shells out.
 */
export async function detectTools(): Promise<ToolDetection[]> {
  const settings = loadSettings();
  return Promise.all(
    TOOL_NAMES.map(async (tool) => {
      const configured = settings.toolPaths[tool]?.trim();
      let resolved: string | null = null;
      let source: ToolDetection['source'] = null;

      if (configured) {
        if (isExecutable(configured)) {
          resolved = configured;
          source = 'setting';
        } else {
          return {
            tool,
            path: configured,
            version: null,
            source: 'setting',
            ok: false,
            error: 'The configured path is not an executable file.'
          };
        }
      }
      if (!resolved) {
        resolved = whichSync(tool);
        if (resolved) source = 'path';
      }
      if (!resolved) {
        resolved = commonLocations(tool).find(isExecutable) ?? null;
        if (resolved) source = 'common-location';
      }
      if (!resolved) {
        return { tool, path: null, version: null, source: null, ok: false };
      }
      const version = await readVersion(resolved);
      return { tool, path: resolved, version, source, ok: true };
    })
  );
}

export async function resolveToolPath(tool: MongoToolName): Promise<string> {
  const detections = await detectTools();
  const detection = detections.find((entry) => entry.tool === tool);
  if (!detection?.ok || !detection.path) {
    throw new Error(
      `${tool} was not found. Set its full path in Settings → MongoDB Database Tools, ` +
        'or use the built-in import/export which needs no external tools.'
    );
  }
  return detection.path;
}

function maskUri(argv: string[]): string {
  return argv
    .map((arg) => arg.replace(/(mongodb(?:\+srv)?:\/\/[^:@\s]+:)[^@\s]+@/i, '$1*****@'))
    .join(' ');
}

/**
 * The database tools reject `--db` alongside `--uri`, so the database has to
 * ride in the connection string's path component instead.
 */
function withDatabase(uri: string, database?: string): string {
  if (!database) return uri;
  const [base, query] = uri.split('?');
  const schemeEnd = base.indexOf('://') + 3;
  const credentialsEnd = base.indexOf('@', schemeEnd);
  const hostStart = credentialsEnd >= 0 ? credentialsEnd + 1 : schemeEnd;
  const pathStart = base.indexOf('/', hostStart);
  const hostPart = pathStart >= 0 ? base.slice(0, pathStart) : base;
  return `${hostPart}/${encodeURIComponent(database)}${query ? `?${query}` : ''}`;
}

function buildToolArgs(request: ToolRunRequest, uri: string): string[] {
  const args = ['--uri', withDatabase(uri, request.database)];
  // mongorestore only accepts --collection when restoring a single .bson file.
  const collectionApplies =
    request.tool !== 'mongorestore' || /\.bson$/i.test(request.target);
  if (request.collection && collectionApplies) args.push('--collection', request.collection);

  switch (request.tool) {
    case 'mongodump':
      args.push('--out', request.target);
      if (request.gzip) args.push('--gzip');
      if (request.query) args.push('--query', request.query);
      break;
    case 'mongorestore':
      if (request.drop) args.push('--drop');
      if (request.gzip) args.push('--gzip');
      // A .archive target uses --archive; a directory is passed via --dir.
      if (/\.(archive|gz)$/i.test(request.target)) args.push(`--archive=${request.target}`);
      else args.push('--dir', request.target);
      break;
    case 'mongoexport':
      args.push('--out', request.target, '--type', request.format ?? 'json');
      if (request.format === 'csv') {
        if (!request.fields || request.fields.length === 0) {
          throw new Error('mongoexport requires an explicit field list when exporting CSV.');
        }
        args.push('--fields', request.fields.join(','));
      }
      if (request.query) args.push('--query', request.query);
      break;
    case 'mongoimport':
      args.push('--file', request.target, '--type', request.format ?? 'json');
      if (request.format === 'csv') args.push('--headerline');
      if (request.drop) args.push('--drop');
      break;
    case 'mongosh':
      throw new Error('mongosh cannot be run as a background job from here.');
    default:
      throw new Error(`Unsupported tool: ${String(request.tool)}`);
  }

  if (request.extraArgs?.length) args.push(...request.extraArgs);
  return args;
}

/** The child a job is running right now, if any — a batch runs several in turn. */
const runningJobs = new Map<string, ReturnType<typeof spawn>>();
/** Jobs still under way, including a batch caught between two of its runs. */
const activeJobs = new Set<string>();
const stoppedJobs = new Set<string>();

export function cancelToolJob(jobId: string): boolean {
  if (!activeJobs.has(jobId)) return false;
  // Remembered so the non-zero exit reads as "the user stopped it", not a
  // failure, and so a batch between runs does not start the next one.
  stoppedJobs.add(jobId);
  runningJobs.get(jobId)?.kill();
  return true;
}

function cancelledError(): Error {
  const error = new Error('Cancelled by user.');
  error.name = 'CancelledError';
  return error;
}

interface ToolExit {
  code: number | null;
  stopped: boolean;
  output: string[];
}

/**
 * One run of one tool, registered under `jobId` so Stop can reach it. Every
 * non-empty line of output is handed to `onLine` as it arrives.
 */
function spawnTool(
  executable: string,
  args: string[],
  jobId: string,
  onLine: (line: string) => void
): Promise<ToolExit> {
  return new Promise((resolve, reject) => {
    const output: string[] = [];
    const child = spawn(executable, args, { windowsHide: true });
    runningJobs.set(jobId, child);

    const read = (raw: string) => {
      for (const line of raw.split(/\r?\n/)) {
        const message = line.trim();
        if (!message) continue;
        output.push(message);
        onLine(message);
      }
    };
    // The database tools report progress on stderr, not stdout.
    child.stdout?.on('data', (chunk) => read(String(chunk)));
    child.stderr?.on('data', (chunk) => read(String(chunk)));

    child.on('error', (error) => {
      runningJobs.delete(jobId);
      reject(error);
    });
    child.on('close', (code) => {
      runningJobs.delete(jobId);
      resolve({ code, stopped: stoppedJobs.has(jobId), output });
    });
  });
}

interface ToolCounts {
  processed?: number;
  total?: number;
  bytes?: number;
  totalBytes?: number;
}

const BYTE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4
};

/**
 * Reads the progress the database tools print on stderr, e.g.
 * `[####....]  shop.orders  12000/45000  (26.7%)` for mongodump/mongoexport or
 * `12.0MB/45.0MB (26.7%)` for mongoimport. Anything else yields nothing.
 */
function parseToolCounts(line: string): ToolCounts {
  const documents = line.match(/(?:^|\s)(\d+)\/(\d+)(?:\s|$)/);
  if (documents) {
    return { processed: Number(documents[1]), total: Number(documents[2]) };
  }
  const sizes = line.match(/([\d.]+)(B|KB|MB|GB|TB)\/([\d.]+)(B|KB|MB|GB|TB)/i);
  if (sizes) {
    const unit = (name: string) => BYTE_UNITS[name.toUpperCase()] ?? 1;
    return {
      bytes: Math.round(Number(sizes[1]) * unit(sizes[2])),
      totalBytes: Math.round(Number(sizes[3]) * unit(sizes[4]))
    };
  }
  return {};
}

/**
 * The exact count a run ends on: `exported 3 records` from mongoexport, or
 * ``done dumping `shop.orders` (3 documents)`` from mongodump.
 */
function parseFinalCount(line: string): number | null {
  const match = line.match(/exported (\d+) records?/) ?? line.match(/done dumping .*\((\d+) documents?\)/);
  return match ? Number(match[1]) : null;
}

export async function runTool(
  request: ToolRunRequest,
  report: (progress: TransferProgress) => void
): Promise<TransferResult> {
  const executable = await resolveToolPath(request.tool);
  const config = getConnection(request.connectionId);
  const secrets = resolveSecrets(request.connectionId);
  const uri = buildConnectionUri(config, secrets, { embedPassword: true });
  const args = buildToolArgs(request, uri);
  const jobId = randomUUID();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  // The tools only tell us how far along they are through their log lines.
  let counted: ToolCounts = {};

  report({
    jobId,
    kind: 'tool',
    phase: 'starting',
    processed: 0,
    total: null,
    startedAt,
    filePath: request.target,
    message: `${path.basename(executable)} ${maskUri(args)}`
  });

  activeJobs.add(jobId);
  try {
    let exit: ToolExit;
    try {
      exit = await spawnTool(executable, args, jobId, (message) => {
        counted = { ...counted, ...parseToolCounts(message) };
        report({
          jobId,
          kind: 'tool',
          phase: 'running',
          processed: counted.processed ?? 0,
          total: counted.total ?? null,
          bytes: counted.bytes,
          totalBytes: counted.totalBytes,
          startedAt,
          filePath: request.target,
          message
        });
      });
    } catch (error) {
      report({
        jobId,
        kind: 'tool',
        phase: 'error',
        processed: counted.processed ?? 0,
        total: counted.total ?? null,
        startedAt,
        filePath: request.target,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    const { code, stopped, output } = exit;
    const ok = code === 0 && !stopped;
    report({
      jobId,
      kind: 'tool',
      phase: stopped ? 'cancelled' : ok ? 'done' : 'error',
      processed: counted.processed ?? 0,
      total: counted.total ?? null,
      startedAt,
      filePath: request.target,
      errors: ok || stopped ? [] : output.slice(-20),
      message: stopped
        ? `${request.tool} stopped: cancelled by user.`
        : ok
          ? `${request.tool} finished successfully`
          : `${request.tool} exited with code ${code}`
    });
    if (stopped) throw cancelledError();
    if (!ok) {
      throw new Error(`${request.tool} exited with code ${code}:\n${output.slice(-10).join('\n')}`);
    }
    return {
      jobId,
      ok: true,
      processed: 0,
      failed: 0,
      filePath: request.target,
      durationMs: Date.now() - started,
      errors: []
    };
  } finally {
    activeJobs.delete(jobId);
    stoppedJobs.delete(jobId);
  }
}

/** How many documents a run over this collection should cover, or null if unknown. */
async function countForTool(
  connectionId: string,
  database: string,
  collection: string,
  filter: Document | null
): Promise<number | null> {
  const target = getDb(connectionId, database).collection(collection);
  const counting = filter
    ? target.countDocuments(filter, { maxTimeMS: 15_000 })
    : target.estimatedDocumentCount({ maxTimeMS: 15_000 });
  return counting.catch(() => null);
}

/**
 * The line that best says why a run failed: the tool's own `Failed:` line when
 * it printed one, otherwise its last words.
 */
function failureReason(output: string[], code: number | null): string {
  const failed = [...output].reverse().find((line) => /Failed:/.test(line));
  const line = failed ?? output[output.length - 1];
  // Drop the timestamp the tools put in front of every line.
  const reason = line?.replace(/^\S+\s+/, '').replace(/^Failed:\s*/, '');
  return reason || `exited with code ${code}`;
}

/**
 * Runs mongodump or mongoexport once per collection, under one job id, so the
 * dialog sees a single job: one bar across every collection, one Stop that ends
 * the run in progress and starts no more, and a part per collection in the
 * result. A collection that fails is recorded and the rest still run.
 *
 * A whole database dumped without a filter stays a single mongodump run: that
 * one also carries the views and the database-level metadata, which dumping
 * collection by collection would leave behind.
 */
export async function runToolBatch(
  request: ToolBatchRequest,
  report: (progress: TransferProgress) => void
): Promise<TransferResult> {
  if (request.tool === 'mongodump' && request.collections.length === 0 && !request.query) {
    return runTool(
      {
        connectionId: request.connectionId,
        tool: 'mongodump',
        database: request.database,
        target: request.directory,
        gzip: request.gzip
      },
      report
    );
  }

  // Checked once here rather than failing every collection with the same error.
  let filter: Document | null = null;
  if (request.query) {
    try {
      filter = EJSON.parse(request.query, { relaxed: false }) as Document;
    } catch (error) {
      throw new Error(
        `The filter is passed to ${request.tool} as --query, so it must be strict JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const executable = await resolveToolPath(request.tool);
  const names =
    request.collections.length > 0
      ? request.collections
      : await exportableCollections(request.connectionId, request.database);
  if (names.length === 0) {
    throw new Error(`${request.database} holds no collections to export.`);
  }

  const config = getConnection(request.connectionId);
  const secrets = resolveSecrets(request.connectionId);
  const uri = buildConnectionUri(config, secrets, { embedPassword: true });
  const jobId = randomUUID();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  // mongodump puts the database folder under --out itself; mongoexport is
  // given file paths, laid out the way the built-in batch export lays them.
  const directory =
    request.tool === 'mongodump'
      ? path.join(request.directory, request.database)
      : path.join(request.directory, safeFileName(request.database));
  const fileFor = (collection: string): string =>
    request.tool === 'mongodump'
      ? path.join(directory, `${collection}.bson${request.gzip ? '.gz' : ''}`)
      : path.join(directory, `${safeFileName(collection)}.json`);

  const counts = await Promise.all(
    names.map((name) => countForTool(request.connectionId, request.database, name, filter))
  );
  const total = counts.some((count) => count === null)
    ? null
    : counts.reduce((sum: number, count) => sum + (count ?? 0), 0);

  const parts: TransferPart[] = [];
  const errors: string[] = [];
  let processed = 0;
  const progress = (
    phase: TransferProgress['phase'],
    done: number,
    message: string,
    extra: Partial<TransferProgress> = {}
  ) =>
    report({
      jobId,
      kind: 'tool',
      phase,
      processed: done,
      total,
      startedAt,
      filePath: directory,
      message,
      ...extra
    });

  progress(
    'starting',
    0,
    `${request.tool}: ${names.length} collections from ${request.database}, one run each`
  );

  activeJobs.add(jobId);
  try {
    if (request.tool === 'mongoexport') fs.mkdirSync(directory, { recursive: true });
    for (const [index, name] of names.entries()) {
      if (stoppedJobs.has(jobId)) throw cancelledError();
      const target = fileFor(name);
      const args = buildToolArgs(
        {
          connectionId: request.connectionId,
          tool: request.tool,
          database: request.database,
          collection: name,
          target: request.tool === 'mongodump' ? request.directory : target,
          format: request.tool === 'mongoexport' ? 'json' : undefined,
          gzip: request.gzip,
          query: request.query
        },
        uri
      );
      const before = processed;
      let current = 0;
      let final: number | null = null;
      let missing = false;
      const label = `${name} — ${index + 1} of ${names.length}`;
      progress('running', before, `${label}: ${path.basename(executable)} ${maskUri(args)}`);

      const exit = await spawnTool(executable, args, jobId, (message) => {
        const seen = parseToolCounts(message).processed;
        if (seen !== undefined) current = seen;
        final = parseFinalCount(message) ?? final;
        // mongodump exits 0 on a collection that is gone, and only says so.
        if (/does not exist/.test(message)) missing = true;
        progress('running', before + current, message);
      });
      if (exit.stopped) throw cancelledError();

      const failure =
        exit.code !== 0
          ? failureReason(exit.output, exit.code)
          : missing
            ? 'the collection does not exist'
            : null;
      if (failure) {
        errors.push(`${name}: ${failure}`);
        parts.push({ collection: name, processed: 0, filePath: target, error: failure });
        continue;
      }
      const written = final ?? current;
      processed = before + written;
      parts.push({ collection: name, processed: written, filePath: target });
    }

    progress(
      'done',
      processed,
      `${request.tool} wrote ${processed.toLocaleString()} documents from ${
        parts.length - errors.length
      } of ${names.length} collections`,
      { total: processed, errors: errors.length > 0 ? errors : undefined }
    );
    return {
      jobId,
      ok: errors.length === 0,
      processed,
      failed: errors.length,
      filePath: directory,
      durationMs: Date.now() - started,
      errors,
      parts
    };
  } catch (error) {
    const isCancel = error instanceof Error && error.name === 'CancelledError';
    progress(
      isCancel ? 'cancelled' : 'error',
      processed,
      isCancel
        ? `${request.tool} stopped: cancelled by user.`
        : error instanceof Error
          ? error.message
          : String(error)
    );
    throw error;
  } finally {
    activeJobs.delete(jobId);
    stoppedJobs.delete(jobId);
  }
}
