import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  MongoToolName,
  ToolDetection,
  ToolRunRequest,
  TransferProgress,
  TransferResult
} from '../../shared/types.js';
import { buildConnectionUri, getConnection, resolveSecrets } from './connections.js';
import { loadSettings } from './store.js';

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

const runningJobs = new Map<string, ReturnType<typeof spawn>>();

export function cancelToolJob(jobId: string): boolean {
  const child = runningJobs.get(jobId);
  if (!child) return false;
  child.kill();
  runningJobs.delete(jobId);
  return true;
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
  const output: string[] = [];

  report({
    jobId,
    kind: 'tool',
    phase: 'starting',
    processed: 0,
    total: null,
    filePath: request.target,
    message: `${path.basename(executable)} ${maskUri(args)}`
  });

  return new Promise<TransferResult>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    runningJobs.set(jobId, child);

    const onLine = (raw: string) => {
      for (const line of raw.split(/\r?\n/)) {
        const message = line.trim();
        if (!message) continue;
        output.push(message);
        report({
          jobId,
          kind: 'tool',
          phase: 'running',
          processed: 0,
          total: null,
          filePath: request.target,
          message
        });
      }
    };

    // The database tools report progress on stderr, not stdout.
    child.stdout?.on('data', (chunk) => onLine(String(chunk)));
    child.stderr?.on('data', (chunk) => onLine(String(chunk)));

    child.on('error', (error) => {
      runningJobs.delete(jobId);
      report({
        jobId,
        kind: 'tool',
        phase: 'error',
        processed: 0,
        total: null,
        filePath: request.target,
        message: error.message
      });
      reject(error);
    });

    child.on('close', (code) => {
      runningJobs.delete(jobId);
      const ok = code === 0;
      report({
        jobId,
        kind: 'tool',
        phase: ok ? 'done' : 'error',
        processed: 0,
        total: null,
        filePath: request.target,
        errors: ok ? [] : output.slice(-20),
        message: ok
          ? `${request.tool} finished successfully`
          : `${request.tool} exited with code ${code}`
      });
      if (!ok) {
        reject(new Error(`${request.tool} exited with code ${code}:\n${output.slice(-10).join('\n')}`));
        return;
      }
      resolve({
        jobId,
        ok: true,
        processed: 0,
        failed: 0,
        filePath: request.target,
        durationMs: Date.now() - started,
        errors: []
      });
    });
  });
}
