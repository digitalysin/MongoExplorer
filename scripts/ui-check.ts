/**
 * Boots the real renderer against a live mongod, drives a short click-through
 * (connect → pick a collection → run a query → open statistics) and writes
 * screenshots plus any renderer console errors. Run with:
 *
 *   npm run ui-check
 */
import { BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { registerIpcHandlers } from '../electron/ipc.js';
import { upsertConnection } from '../electron/services/connections.js';

const HOST = '127.0.0.1:27099';
const DATABASE = 'mongo_explorer_ui';
const outputDir = path.resolve('artifacts');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoexp-ui-'));

const consoleErrors: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedDatabase(): Promise<void> {
  const client = new MongoClient(`mongodb://${HOST}`);
  await client.connect();
  const db = client.db(DATABASE);
  await db.dropDatabase().catch(() => undefined);
  await db.collection('orders').insertMany(
    Array.from({ length: 250 }, (_, index) => ({
      reference: `ORD-${1000 + index}`,
      status: ['paid', 'pending', 'refunded'][index % 3],
      amount: Math.round((index * 13.37 + 5) * 100) / 100,
      currency: 'IDR',
      customer: { name: `Customer ${index}`, city: ['Jakarta', 'Bandung', 'Bali'][index % 3] },
      items: [{ sku: `SKU-${index % 20}`, quantity: (index % 4) + 1 }],
      createdAt: new Date(Date.UTC(2025, index % 12, (index % 27) + 1))
    }))
  );
  await db.collection('orders').createIndex({ reference: 1 }, { unique: true });
  await db.collection('orders').createIndex({ status: 1, createdAt: -1 });
  await db.collection('customers').insertMany(
    Array.from({ length: 40 }, (_, index) => ({
      name: `Customer ${index}`,
      email: `customer${index}@example.com`,
      loyaltyPoints: index * 7
    }))
  );
  await client.close();
}

async function click(window: BrowserWindow, selector: string, text?: string): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    (() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const target = ${text ? `nodes.find((node) => node.textContent.includes(${JSON.stringify(text)}))` : 'nodes[0]'};
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
}

async function shoot(window: BrowserWindow, name: string): Promise<void> {
  const image = await window.webContents.capturePage();
  const file = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`  saved ${file}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });
  app.setPath('userData', path.join(workDir, 'userData'));
  await seedDatabase();

  upsertConnection({
    name: 'Local mongod (27099)',
    mode: 'fields',
    hosts: [HOST],
    savePassword: false,
    color: '#3ba55d'
  });
  upsertConnection({
    name: 'Atlas staging (example)',
    mode: 'uri',
    uri: 'mongodb+srv://reader@cluster0.example.mongodb.net',
    savePassword: false,
    color: '#5b8def'
  });

  registerIpcHandlers();

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.resolve('dist/main/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      consoleErrors.push(`[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    consoleErrors.push(`renderer gone: ${details.reason}`);
  });

  await window.loadFile(path.resolve('dist/renderer/index.html'));
  await wait(700);
  await shoot(window, '01-empty');

  console.log('  clicking the local connection…');
  await click(window, '.connection-row', 'Local mongod');
  await wait(2500);
  await shoot(window, '02-connected');

  console.log(`  opening the ${DATABASE} database…`);
  await click(window, '.tree-node.level-1', DATABASE);
  await wait(1500);

  console.log('  selecting the orders collection…');
  await click(window, '.tree-node.level-2', 'orders');
  await wait(400);
  await shoot(window, '03-tree');

  console.log('  opening a query tab…');
  await click(window, '.titlebar-actions .btn', 'New query');
  await wait(600);
  await click(window, '.toolbar .btn-primary');
  await wait(2000);
  await shoot(window, '04-query-results');

  console.log('  switching the result to JSON…');
  await click(window, '.segmented button', 'JSON');
  await wait(500);
  await shoot(window, '05-query-json');

  console.log('  opening statistics…');
  await click(window, '.titlebar-actions .btn', 'Statistics');
  await wait(2500);
  await shoot(window, '06-statistics');

  console.log('  opening the export dialog…');
  await click(window, '.titlebar-actions .btn', 'Export');
  await wait(600);
  await shoot(window, '07-export');
  await click(window, '.modal-footer .btn', 'Close');
  await wait(300);

  console.log('  opening settings…');
  await click(window, '.titlebar-actions .btn', 'Settings');
  await wait(1500);
  await shoot(window, '08-settings');

  const client = new MongoClient(`mongodb://${HOST}`);
  await client.connect();
  await client.db(DATABASE).dropDatabase();
  await client.close();

  if (consoleErrors.length > 0) {
    console.error('\nRenderer reported problems:');
    for (const message of consoleErrors) console.error(`  ${message}`);
    app.exit(1);
    return;
  }
  console.log('\nUI check finished with a clean console.');
  fs.rmSync(workDir, { recursive: true, force: true });
  app.exit(0);
}

void app.whenReady().then(() =>
  main().catch((error) => {
    console.error('UI check failed:', error);
    app.exit(1);
  })
);

setTimeout(() => {
  console.error('UI check timed out');
  app.exit(1);
}, 120_000).unref();
