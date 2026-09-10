import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await esbuild.build({
  entryPoints: [path.join(root, 'scripts/ui-check.ts')],
  outfile: path.join(root, 'dist/smoke/ui-check.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'inline',
  logLevel: 'info',
  external: ['electron', 'mongodb']
});
