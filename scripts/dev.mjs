import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import esbuild from 'esbuild';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
  external: ['electron', 'mongodb']
};

let electronProcess = null;
let restarting = false;

function startElectron(devServerUrl) {
  if (electronProcess) {
    restarting = true;
    electronProcess.kill();
    electronProcess = null;
  }
  electronProcess = spawn(electronPath, [path.join(root, 'dist/main/main.js')], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, NODE_ENV: 'development' }
  });
  electronProcess.on('close', () => {
    if (restarting) {
      restarting = false;
      return;
    }
    process.exit(0);
  });
}

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const address = server.resolvedUrls?.local?.[0];
if (!address) throw new Error('Vite did not report a local dev server URL.');
server.printUrls();

// Rebuilding the main bundle restarts Electron; the renderer hot-reloads itself.
const restartPlugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error('[dev] main process build failed');
        return;
      }
      startElectron(address);
    });
  }
};

const mainContext = await esbuild.context({
  ...common,
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(root, 'dist/main/main.js'),
  format: 'esm',
  plugins: [restartPlugin]
});

const preloadContext = await esbuild.context({
  ...common,
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(root, 'dist/main/preload.cjs'),
  format: 'cjs'
});

await preloadContext.watch();
await mainContext.watch();

const shutdown = async () => {
  restarting = false;
  electronProcess?.kill();
  await Promise.all([mainContext.dispose(), preloadContext.dispose(), server.close()]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
