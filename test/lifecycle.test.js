'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { startServer } = require('./helpers/lsp');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error('Timed out waiting for LSP diagnostics');
    await delay(20);
  }
}

test('diagnostic lifecycle handles debounce, stale versions, off, close and cancellation', { timeout: 15000, skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bend2-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = path.join(root, 'compiler');
  await fs.writeFile(compiler, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const wrapper = process.argv[2];
const target = fs.readFileSync(wrapper, 'utf8').match(/import (\\S+)/)[1];
const text = fs.readFileSync(path.resolve(path.dirname(wrapper), target), 'utf8');
setTimeout(() => {
  if (text.includes('BAD')) { console.log('Error: bad source'); process.exitCode = 1; }
  else console.log('All terms check.');
}, text.includes('SLOW') ? 500 : 0);
`, { mode: 0o700 });
  const settings = { executablePath: compiler, lint: { run: 'onType', delay: 100, onOpen: true } };
  const server = await startServer(pathToFileURL(root).href, settings);
  t.after(() => server.stop());
  const uri = pathToFileURL(path.join(root, 'Main.bend')).href;
  await server.open(uri, 'BAD');
  await until(() => server.diagnostics.get(uri)?.version === 1);
  assert.equal(server.diagnostics.get(uri).diagnostics.length, 1);
  await server.change(uri, 'good', 2);
  await until(() => server.diagnostics.get(uri)?.version === 2);
  assert.equal(server.diagnostics.get(uri).diagnostics.length, 0);
  await server.change(uri, 'SLOW BAD', 3);
  const pending = server.connection.sendRequest('bend2/check', { uri });
  await delay(60);
  await server.change(uri, 'good', 4);
  assert.equal((await pending).status, 'cancelled');
  await until(() => server.diagnostics.get(uri)?.version === 4);
  await delay(600);
  assert.equal(server.diagnostics.get(uri).version, 4);
  assert.equal(server.diagnostics.get(uri).diagnostics.length, 0);
  settings.lint.run = 'off';
  await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: { bend2: settings } });
  await server.change(uri, 'BAD', 5);
  await delay(300);
  assert.equal(server.diagnostics.get(uri).diagnostics.length, 0);
  assert.equal((await server.connection.sendRequest('bend2/check', { uri })).status, 'failed');
  await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
  await until(() => server.diagnostics.get(uri)?.diagnostics.length === 0);
});
