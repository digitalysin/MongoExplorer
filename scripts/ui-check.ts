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
import { PROGRESS_CHANNEL, registerIpcHandlers } from '../electron/ipc.js';
import { upsertConnection } from '../electron/services/connections.js';

const HOST = '127.0.0.1:27099';
const DATABASE = 'mongo_explorer_ui';
const CREATED_DATABASE = 'mongo_explorer_ui_new';
const outputDir = path.resolve('artifacts');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoexp-ui-'));

const consoleErrors: string[] = [];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedDatabase(): Promise<void> {
  const client = new MongoClient(`mongodb://${HOST}`);
  await client.connect();
  const db = client.db(DATABASE);
  await db.dropDatabase().catch(() => undefined);
  await client.db(CREATED_DATABASE).dropDatabase().catch(() => undefined);
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
  // Long enough to be clipped at the default sidebar width — the resize check depends on it.
  await db.collection('price_update_configuration_history_archive').insertOne({ note: 'long name' });
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

/** Types into a controlled React input by going through the native value setter. */
async function fill(window: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
}

/** Types into the input of the `.field` whose label matches, by going through
 *  the native value setter so React sees the change. */
async function fillField(window: BrowserWindow, label: string, value: string): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll('.modal .field')].find(
        (node) => node.querySelector('.field-label')?.textContent === ${JSON.stringify(label)}
      );
      const input = field?.querySelector('input.input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
}

/** Dispatches a mouse event on the cell in `row` under the named column. */
async function cellEvent(
  window: BrowserWindow,
  row: number,
  column: string,
  type: 'dblclick' | 'contextmenu'
): Promise<{ ok: boolean; reason?: string; text?: string }> {
  return window.webContents.executeJavaScript(`
    (() => {
      const headers = [...document.querySelectorAll('.data-table thead th')].map((node) => node.textContent);
      const index = headers.indexOf(${JSON.stringify(column)});
      if (index < 0) return { ok: false, reason: 'no ' + ${JSON.stringify(column)} + ' column in ' + headers.join(',') };
      const tr = document.querySelectorAll('.data-table tbody tr')[${row}];
      if (!tr) return { ok: false, reason: 'no row ${row}' };
      const cell = tr.children[index];
      const box = cell.getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
        bubbles: true,
        clientX: Math.round(box.left + 8),
        clientY: Math.round(box.top + 8)
      }));
      return { ok: true, text: cell.textContent };
    })()
  `);
}

async function cellText(window: BrowserWindow, row: number, column: string): Promise<string> {
  return window.webContents.executeJavaScript(`
    (() => {
      const headers = [...document.querySelectorAll('.data-table thead th')].map((node) => node.textContent);
      const index = headers.indexOf(${JSON.stringify(column)});
      const tr = document.querySelectorAll('.data-table tbody tr')[${row}];
      return index < 0 || !tr ? '' : tr.children[index].textContent;
    })()
  `);
}

/** Commits an open in-place cell editor with the given text. */
async function commitCellEditor(window: BrowserWindow, value: string): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('input.cell-editor');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
}

/** The column whose cell is currently in edit mode, or '' when none is. */
async function editingColumn(window: BrowserWindow): Promise<string> {
  return window.webContents.executeJavaScript(`
    (() => {
      const cell = document.querySelector('.data-table td.is-editing');
      if (!cell) return '';
      const headers = [...document.querySelectorAll('.data-table thead th')].map((node) => node.textContent);
      return headers[[...cell.parentElement.children].indexOf(cell)] ?? '';
    })()
  `);
}

async function keyOnEditor(window: BrowserWindow, key: string): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.cell-editor');
      if (!input) return false;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      return true;
    })()
  `);
}

async function count(window: BrowserWindow, selector: string): Promise<number> {
  return window.webContents.executeJavaScript(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`
  );
}

async function textOf(window: BrowserWindow, selector: string): Promise<string> {
  return window.webContents.executeJavaScript(`
    [...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent).join(' | ')
  `);
}

/** Writes an NDJSON file big enough that importing it cannot finish instantly. */
async function writeBigNdjson(filePath: string, documents: number): Promise<void> {
  const stream = fs.createWriteStream(filePath);
  for (let index = 0; index < documents; index += 1) {
    const line = `${JSON.stringify({ index, label: `row-${index}`, note: 'x'.repeat(80) })}\n`;
    if (!stream.write(line)) {
      await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
    }
  }
  await new Promise<void>((resolve) => stream.end(resolve));
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

  console.log('  a failed test must not outlive the field it described…');
  await click(window, '.sidebar-header .btn-primary', '+ New');
  await wait(600);
  if ((await textOf(window, '.modal h2')) === '') throw new Error('the connection dialog did not open');
  await fill(window, '.modal .input', 'Stale error check');
  await click(window, '.modal .segmented button', 'Individual fields');
  await wait(300);
  if (!(await fill(window, '.modal input[placeholder="localhost:27017"]', 'no-such-host.invalid:27017'))) {
    throw new Error('the hosts field is not visible in individual-fields mode');
  }
  await click(window, '.modal-footer .btn', 'Test connection');
  // The driver keeps retrying until server selection times out, so this is not instant.
  await wait(13_000);
  const failure = await textOf(window, '.modal .error-box');
  if (!/DNS returned no address/.test(failure)) {
    throw new Error(`expected a DNS explanation, got: ${failure || '(no error shown)'}`);
  }
  await shoot(window, '03-connection-error');
  // Editing the host makes the message stale — it must clear rather than describe the old value.
  await fill(window, '.modal input[placeholder="localhost:27017"]', HOST);
  await wait(400);
  const afterEdit = await textOf(window, '.modal .error-box');
  if (afterEdit.trim() !== '') {
    throw new Error(`the stale error survived an edit: ${afterEdit}`);
  }
  await shoot(window, '04-error-cleared');
  await click(window, '.modal-footer .btn', 'Cancel');
  await wait(400);

  console.log('  creating a database…');
  if (!(await click(window, '.connection-row .icon-button[title="New database"]'))) {
    throw new Error('the New database action is missing from the connection row');
  }
  await wait(500);
  await fill(window, '.modal .input', CREATED_DATABASE);
  await fill(window, '.modal .field:last-of-type .input', 'events');
  await wait(200);
  await shoot(window, '05-create-database');
  await click(window, '.modal-footer .btn-primary', 'Create');
  await wait(2000);
  const tree = await textOf(window, '.tree-node.level-1');
  if (!tree.includes(CREATED_DATABASE)) {
    throw new Error(`the created database is not in the tree: ${tree}`);
  }
  await shoot(window, '06-database-created');

  console.log(`  opening the ${DATABASE} database…`);
  await click(window, '.tree-node.level-1', DATABASE);
  await wait(1500);

  console.log('  selecting the orders collection…');
  await click(window, '.tree-node.level-2', 'orders');
  await wait(400);
  await shoot(window, '07-tree');

  console.log('  widening the sidebar…');
  const clippedNames = () =>
    window.webContents.executeJavaScript(`
      [...document.querySelectorAll('.tree-node.level-2 .label')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1).length
    `) as Promise<number>;
  if ((await clippedNames()) === 0) {
    throw new Error('expected a long collection name to be clipped at the default width');
  }
  const widened = await window.webContents.executeJavaScript(`
    (() => {
      const handle = document.querySelector('.sidebar-resizer');
      if (!handle) return { ok: false, reason: 'no resize handle' };
      const before = document.querySelector('.sidebar').getBoundingClientRect().width;
      const y = handle.getBoundingClientRect().top + 40;
      const opts = { bubbles: true, clientY: y, pointerId: 1 };
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: before }));
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: before + 180 }));
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: before + 180 }));
      const after = document.querySelector('.sidebar').getBoundingClientRect().width;
      return { ok: true, before, after, stored: localStorage.getItem('mongo-explorer:sidebar-width') };
    })()
  `);
  if (!widened.ok) throw new Error(`sidebar resize failed: ${widened.reason}`);
  if (widened.after < widened.before + 150) {
    throw new Error(`dragging did not widen the sidebar: ${widened.before} -> ${widened.after}`);
  }
  if (widened.stored === null) throw new Error('the new width was not remembered');
  await wait(500);
  // A clipped label reports a scroll width wider than the box drawn for it.
  const stillClipped = await clippedNames();
  if (stillClipped > 0) {
    throw new Error(`${stillClipped} collection names are still clipped at ${widened.after}px`);
  }
  console.log(`    ${Math.round(widened.before)}px -> ${Math.round(widened.after)}px, no clipped names`);
  await shoot(window, '08-sidebar-widened');

  console.log('  opening a query tab…');
  await click(window, '.titlebar-actions .btn', 'New query');
  await wait(600);
  await click(window, '.toolbar .btn-primary');
  await wait(2000);
  await shoot(window, '09-query-results');

  console.log('  editing a cell in place…');
  const verifier = new MongoClient(`mongodb://${HOST}`);
  await verifier.connect();
  const orders = verifier.db(DATABASE).collection('orders');
  const reference = (await cellText(window, 0, 'reference')).trim();
  if (!reference) throw new Error('the first row has no reference to identify it by');

  const opened = await cellEvent(window, 0, 'status', 'dblclick');
  if (!opened.ok) throw new Error(`could not open the status cell: ${opened.reason}`);
  await wait(300);
  await shoot(window, '09b-cell-editing');
  if (!(await commitCellEditor(window, 'settled'))) {
    throw new Error('double-clicking the status cell did not open an editor');
  }
  await wait(1200);
  const stored = await orders.findOne({ reference });
  if (stored?.status !== 'settled') {
    throw new Error(`the in-place edit did not reach mongod: status is ${String(stored?.status)}`);
  }
  if (!(await cellText(window, 0, 'status')).includes('settled')) {
    throw new Error('the table still shows the old status');
  }
  // Patching one cell must not look like a new result and drop the cursor.
  if ((await count(window, '.data-table td.is-selected')) !== 1) {
    throw new Error('the edited cell lost its selection after the write');
  }
  // A finished operation confirms itself without interrupting anyone.
  const toast = await textOf(window, '.toast.kind-success');
  if (!toast.includes('Updated “status”')) {
    throw new Error(`the write did not confirm itself in a toast: ${toast || '(no toast)'}`);
  }

  console.log('  tabbing to the next cell…');
  if (!(await cellEvent(window, 0, 'status', 'dblclick')).ok) {
    throw new Error('could not reopen the status editor');
  }
  await wait(300);
  await keyOnEditor(window, 'Tab');
  await wait(600);
  const tabbedTo = await editingColumn(window);
  if (tabbedTo !== 'amount') {
    throw new Error(`Tab should move the editor to amount, it went to "${tabbedTo}"`);
  }
  await keyOnEditor(window, 'Escape');
  await wait(300);
  if ((await editingColumn(window)) !== '') throw new Error('Escape did not close the editor');
  const untouched = await orders.findOne({ reference });
  if (untouched?.amount !== stored?.amount) {
    throw new Error('moving through cells without typing must not write anything');
  }

  console.log('  editing numbers without changing their BSON type…');
  const amountOf = async (order: string) => {
    const [row] = await orders
      .aggregate([{ $match: { reference: order } }, { $project: { type: { $type: '$amount' } } }])
      .toArray();
    return String(row?.type);
  };
  // Row 1 holds a whole number, which the driver stored as an int32; row 2 holds
  // a fractional one, a double. A whole number typed into either must not move
  // the field to the other type.
  for (const [row, expected] of [
    [0, 'int'],
    [1, 'double']
  ] as const) {
    const order = (await cellText(window, row, 'reference')).trim();
    if ((await amountOf(order)) !== expected) {
      throw new Error(`the seed changed: ${order}.amount is not a ${expected}`);
    }
    if (!(await cellEvent(window, row, 'amount', 'dblclick')).ok) {
      throw new Error(`could not open the amount editor on row ${row}`);
    }
    await wait(300);
    if (!(await commitCellEditor(window, '42'))) throw new Error('the amount editor did not open');
    await wait(1200);
    const actual = await amountOf(order);
    if (actual !== expected) {
      throw new Error(`editing ${order}.amount turned a ${expected} into a ${actual}`);
    }
    if (!(await cellText(window, row, 'amount')).includes('42')) {
      throw new Error(`row ${row} still shows the old amount`);
    }
  }

  console.log('  a rejected value must block rather than fade away…');
  if (!(await cellEvent(window, 0, 'amount', 'dblclick')).ok) {
    throw new Error('could not open the amount editor');
  }
  await wait(300);
  await commitCellEditor(window, 'not a number');
  await wait(600);
  const dialog = await textOf(window, '.modal-header');
  if (!dialog.includes('Something went wrong') || !dialog.includes('amount')) {
    throw new Error(`a rejected value did not raise the error dialog: ${dialog || '(none)'}`);
  }
  if (!(await textOf(window, '.modal-body')).includes('is not a number')) {
    throw new Error('the error dialog does not say why the value was rejected');
  }
  await shoot(window, '09c-error-dialog');
  await click(window, '.modal-footer .btn', 'Close');
  await wait(300);
  if ((await count(window, '.modal')) !== 0) throw new Error('the error dialog did not close');
  await keyOnEditor(window, 'Escape');
  await wait(300);
  if ((await amountOf(reference)) !== 'int') {
    throw new Error('a rejected value must not be written');
  }

  console.log('  right-clicking a row…');
  const menuOpened = await cellEvent(window, 0, 'status', 'contextmenu');
  if (!menuOpened.ok) throw new Error(`could not right-click the status cell: ${menuOpened.reason}`);
  await wait(400);
  const menu = await textOf(window, '.context-menu-item');
  for (const label of [
    'Edit “status”',
    'Edit document…',
    'Copy value',
    'Filter by this value',
    'Duplicate document',
    'Delete document…'
  ]) {
    if (!menu.includes(label)) throw new Error(`the context menu is missing "${label}": ${menu}`);
  }
  await shoot(window, '09d-row-context-menu');
  if (!(await click(window, '.context-menu-item', 'Set to null'))) {
    throw new Error('the context menu has no "Set to null" action');
  }
  await wait(1200);
  const nulled = await orders.findOne({ reference });
  if (nulled?.status !== null) {
    throw new Error(`"Set to null" did not write null: status is ${String(nulled?.status)}`);
  }
  await orders.updateOne({ reference }, { $set: { status: 'paid' } });
  await verifier.close();

  // A throwaway tab, so the screenshots below keep showing the unfiltered query.
  console.log('  filtering by a clicked value…');
  await click(window, '.titlebar-actions .btn', 'New query');
  await wait(600);
  await click(window, '.toolbar .btn-primary');
  await wait(2000);
  if (!(await cellEvent(window, 1, 'status', 'contextmenu')).ok) {
    throw new Error('could not right-click the second row');
  }
  await wait(400);
  if (!(await click(window, '.context-menu-item', 'Filter by this value'))) {
    throw new Error('the context menu has no "Filter by this value" action');
  }
  await wait(2000);
  const filteredCode = await textOf(window, '.cm-content');
  if (!filteredCode.includes('find({ status: "pending" })')) {
    throw new Error(`the filter was not written into the editor: ${filteredCode}`);
  }
  if (!(await cellText(window, 0, 'status')).includes('pending')) {
    throw new Error('the filtered result still holds other statuses');
  }
  await shoot(window, '09e-filtered-by-value');
  await click(window, '.tab.is-active .tab-close');
  await wait(500);

  console.log('  switching the result to JSON…');
  await click(window, '.segmented button', 'JSON');
  await wait(500);
  await shoot(window, '10-query-json');

  console.log('  opening statistics…');
  await click(window, '.titlebar-actions .btn', 'Statistics');
  await wait(2500);
  await shoot(window, '11-statistics');

  console.log('  opening the create-index dialog…');
  await click(window, '.stats-section .btn', 'Create index');
  await wait(600);
  await shoot(window, '12-create-index');
  await click(window, '.modal-footer .btn', 'Cancel');
  await wait(300);

  console.log('  back to the query tab, editing a document…');
  await click(window, '.tabs .tab');
  await wait(500);
  await click(window, '.cell-index');
  await wait(1200);
  await shoot(window, '13-document-editor');
  await click(window, '.modal-footer .btn', 'Close');
  await wait(300);

  console.log('  opening the query library…');
  await click(window, '.toolbar .btn', 'History');
  await wait(900);
  await shoot(window, '14-query-library');
  await click(window, '.modal-footer .btn', 'Close');
  await wait(300);

  console.log('  opening the export dialog…');
  await click(window, '.titlebar-actions .btn', 'Export');
  await wait(600);
  await shoot(window, '15-export');

  console.log('  running an export through the dialog…');
  const exportPath = path.join(workDir, 'orders-export.ndjson');
  await fill(window, '.modal .form-grid .row .input', exportPath);
  await click(window, '.modal-footer .btn', 'Export');
  await wait(2500);
  const exportSummary = await textOf(window, '.modal .badge');
  if (!/Exported 250 documents/.test(exportSummary)) {
    throw new Error(`the export did not report its result: ${exportSummary}`);
  }
  if (!fs.existsSync(exportPath)) throw new Error('the export wrote no file');
  await shoot(window, '15b-export-done');
  await click(window, '.modal-footer .btn', 'Close');
  await wait(300);

  console.log('  checking the running-transfer indicator…');
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  window.webContents.send(PROGRESS_CHANNEL, {
    jobId: 'ui-check-job',
    kind: 'export',
    phase: 'running',
    processed: 4000,
    total: 16_000,
    bytes: 2_500_000,
    startedAt,
    filePath: exportPath,
    message: 'Exporting mongo_explorer_ui.orders'
  });
  await wait(400);
  const indicator = await textOf(window, '.status-right .transfer-status');
  for (const fragment of ['Export', '25%', '0:20', '1:00 left']) {
    if (!indicator.includes(fragment)) {
      throw new Error(`the status bar should mention ${fragment}, saw: ${indicator}`);
    }
  }
  const barWidth = await window.webContents.executeJavaScript(
    `document.querySelector('.status-right .transfer-status .progress > span').style.width`
  );
  if (barWidth !== '25%') throw new Error(`the bar should be a quarter full, saw ${barWidth}`);
  await shoot(window, '15c-transfer-progress');
  window.webContents.send(PROGRESS_CHANNEL, {
    jobId: 'ui-check-job',
    kind: 'export',
    phase: 'done',
    processed: 16_000,
    total: 16_000,
    startedAt,
    filePath: exportPath
  });
  await wait(300);

  console.log('  watching a long import and stopping it…');
  const bigFile = path.join(workDir, 'big.ndjson');
  await writeBigNdjson(bigFile, 600_000);

  await click(window, '.titlebar-actions .btn', 'Import');
  await wait(600);
  await fillField(window, 'Source file', bigFile);
  await fillField(window, 'Target collection', 'ui_check_import');
  await click(window, '.modal-footer .btn', 'Import');

  // Wait for the counts to appear rather than for a fixed moment in the job.
  let panel = '';
  for (let attempt = 0; attempt < 25 && !panel.includes('documents'); attempt += 1) {
    await wait(100);
    panel = await textOf(window, '.modal .transfer-progress');
  }
  for (const fragment of ['%', 'elapsed', 'documents', 'Stop']) {
    if (!panel.includes(fragment)) {
      throw new Error(`the progress panel should mention ${fragment}, saw: ${panel}`);
    }
  }
  await shoot(window, '15d-import-progress');

  console.log('  stopping it…');
  if (!(await click(window, '.transfer-progress .btn', 'Stop'))) {
    throw new Error('the progress panel offered no way to stop the job');
  }
  await wait(2500);
  const stopped = await textOf(window, '.modal .badge');
  if (!/Stopped before it finished/.test(stopped)) {
    throw new Error(`stopping should say what it left behind, saw: ${stopped}`);
  }
  if ((await count(window, '.modal .transfer-progress')) !== 0) {
    throw new Error('the progress panel should disappear once the job is over');
  }
  await shoot(window, '15e-import-stopped');
  await click(window, '.modal-footer .btn', 'Close');
  await wait(300);

  console.log('  opening settings…');
  await click(window, '.titlebar-actions .btn', 'Settings');
  await wait(1500);
  await shoot(window, '16-settings');

  const client = new MongoClient(`mongodb://${HOST}`);
  await client.connect();
  await client.db(DATABASE).dropDatabase();
  await client.db(CREATED_DATABASE).dropDatabase();
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
