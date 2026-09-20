'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
async function startServer(rootUri, settings = {}) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../src/server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const diagnostics = new Map();
  connection.onNotification('textDocument/publishDiagnostics', (params) => diagnostics.set(params.uri, params));
  connection.onRequest('workspace/configuration', (params) => params.items.map(() => settings));
  connection.listen();
  const initialization = await connection.sendRequest('initialize', { processId: process.pid, rootUri,
    capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: { rename: { prepareSupport: true } } } });
  await connection.sendNotification('initialized', {});
  return {
    connection, diagnostics, initialization,
    async open(uri, text, version = 1) { await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'bend2', version, text } }); },
    async change(uri, text, version = 2) { await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] }); },
    async stop() {
      await connection.sendRequest('shutdown');
      await connection.sendNotification('exit');
      connection.dispose();
      child.kill();
      if (stderr) throw new Error(stderr);
    }
  };
}
function position(text, needle, after = 0) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Missing ${needle}`);
  const before = text.slice(0, index + after).split('\n');
  return { line: before.length - 1, character: before.at(-1).length };
}
module.exports = { startServer, position };
