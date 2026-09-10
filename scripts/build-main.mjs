import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Shared esbuild options for both main-process bundles. */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Electron is injected at runtime; the driver ships as a real dependency so
  // its optional native extras keep resolving from node_modules.
  external: ['electron', 'mongodb']
};

const builds = [
  {
    ...common,
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(root, 'dist/main/main.js'),
    format: 'esm'
  },
  {
    ...common,
    // Preload stays CommonJS: it is the most portable format across Electron
    // versions and sandbox settings.
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(root, 'dist/main/preload.cjs'),
    format: 'cjs'
  }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('[build-main] watching for changes');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log('[build-main] done');
}
