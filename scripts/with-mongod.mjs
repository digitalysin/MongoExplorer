/**
 * Runs a command against a throwaway mongod on port 27099, starting one only if
 * nothing is listening there already:
 *
 *   node scripts/with-mongod.mjs electron dist/smoke/smoke.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.MONGO_TEST_PORT ?? 27099);
const command = process.argv.slice(2);

if (command.length === 0) {
  console.error('usage: node scripts/with-mongod.mjs <command> [args…]');
  process.exit(2);
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net
      .connect({ port, host: '127.0.0.1' })
      .on('connect', () => {
        socket.end();
        resolve(true);
      })
      .on('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function main() {
  let mongod = null;
  let dataDir = null;

  if (await portIsOpen(PORT)) {
    console.log(`[with-mongod] reusing the server already listening on ${PORT}`);
  } else {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoexp-mongod-'));
    console.log(`[with-mongod] starting mongod on ${PORT} (${dataDir})`);
    mongod = spawn(
      'mongod',
      ['--dbpath', dataDir, '--port', String(PORT), '--bind_ip', '127.0.0.1'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let startupError = '';
    mongod.stderr?.on('data', (chunk) => (startupError += String(chunk)));
    mongod.on('error', (error) => {
      console.error(
        error.code === 'ENOENT'
          ? '[with-mongod] mongod was not found on PATH. Install MongoDB Community Server, ' +
              `or start your own server on port ${PORT} before running this command.`
          : `[with-mongod] ${error.message}`
      );
      process.exit(1);
    });

    if (!(await waitForPort(PORT, 20_000))) {
      console.error(`[with-mongod] mongod did not start within 20s. ${startupError}`);
      mongod.kill();
      process.exit(1);
    }
  }

  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('close', resolve));

  if (mongod) {
    mongod.kill('SIGTERM');
    await new Promise((resolve) => mongod.on('close', resolve));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('[with-mongod] stopped mongod');
  }
  process.exit(code ?? 0);
}

void main();
