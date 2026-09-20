'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { checkDocument } = require('../../src/checker');
const { startServer, position } = require('../helpers/lsp');
const root = path.resolve(process.env.BEND2_TEST_PROJECT || path.join(__dirname, '../../../bend-tensor'));
const executablePath = process.env.BEND2_TEST_COMPILER || 'bend';
const settings = { executablePath, lint: { run: 'off', timeout: 20000 } };

test('Bend 2 compiler validates every bend-tensor source through isolated graphs', { timeout: 120000 }, async () => {
  const files = ['Tensor.bend', 'Ops/Add.bend', 'Ops/MatMul.bend', 'Ops/ReLU.bend', 'Ops/Transpose.bend', 'NN/Linear.bend', 'LAWS.bend', 'PROOF.bend', 'examples/Smoke.bend', 'tests/Ops.bend', 'benchmarks/matmul/Main.bend'];
  for (const file of files) {
    const full = path.join(root, file);
    const doc = TextDocument.create(pathToFileURL(full).href, 'bend2', 1, await fs.readFile(full, 'utf8'));
    const result = await checkDocument(doc, settings, (file) => fs.readFile(file, 'utf8'));
    assert.equal(result.status, 'passed', `${file}: ${result.message}`);
  }
  const invalid = path.join(root, 'tests/InvalidMatMul.bend');
  const doc = TextDocument.create(pathToFileURL(invalid).href, 'bend2', 1, await fs.readFile(invalid, 'utf8'));
  const result = await checkDocument(doc, settings, (file) => fs.readFile(file, 'utf8'));
  assert.equal(result.status, 'failed');
  assert.ok(result.diagnostics.some((item) => item.severity === 1));
});

test('bend-tensor through LSP: native Base docs, constructors, laws, unsaved imports', { timeout: 60000 }, async (t) => {
  const server = await startServer(pathToFileURL(root).href, settings);
  t.after(() => server.stop());
  const file = path.join(root, 'Ops/MatMul.bend');
  const uri = pathToFileURL(file).href;
  const original = await fs.readFile(file, 'utf8');
  await server.open(uri, original);
  const ask = (method, pos) => server.connection.sendRequest(`textDocument/${method}`, { textDocument: { uri }, position: pos });
  const f32 = await ask('completion', position(original, 'F32.add', 4));
  assert.equal(f32.find((item) => item.label === 'add').textEdit.newText, 'add(${1:a}, ${2:b})');
  const signature = await ask('signatureHelp', position(original, 'F32.add(', 8));
  assert.equal(signature.signatures[0].parameters.length, 2);
  assert.match(signature.signatures[0].label, /a: F32, b: F32/);
  const ctor = await ask('completion', position(original, 'T.Cell.new', 7));
  assert.equal(ctor.find((item) => item.label === 'new').textEdit.newText, 'new{${1:head}, ${2:tail}}');
  const definition = await ask('definition', position(original, 'T.Vec', 3));
  assert.equal(definition.uri, pathToFileURL(path.join(root, 'Tensor.bend')).href);
  assert.match((await ask('hover', position(original, 'T.Vec', 3))).contents.value, /length-indexed/);
  const docs = await server.connection.sendRequest('bend2/documentation', { uri, query: 'F32.add' });
  assert.match(docs, /for a: F32/);
  const guide = await server.connection.sendRequest('bend2/documentation', { uri, query: 'guide' });
  assert.match(guide, /Quantities/);
  const lawUri = pathToFileURL(path.join(root, 'LAWS.bend')).href;
  await server.open(lawUri, await fs.readFile(path.join(root, 'LAWS.bend'), 'utf8'));
  assert.equal((await server.connection.sendRequest('bend2/check', { uri: lawUri })).status, 'passed');
  const tensorUri = pathToFileURL(path.join(root, 'Tensor.bend')).href;
  await server.open(tensorUri, (await fs.readFile(path.join(root, 'Tensor.bend'), 'utf8')) + '\ndef broken() -> Nat:\n  UndefinedSymbol\n');
  const bad = await server.connection.sendRequest('bend2/check', { uri });
  assert.equal(bad.status, 'failed');
  assert.match(bad.message, /UndefinedSymbol/);
  assert.ok(server.diagnostics.get(uri).diagnostics.length);
  await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri: tensorUri } });
  assert.equal((await server.connection.sendRequest('bend2/check', { uri })).status, 'passed');
});

test('checking IO main never executes it and leaves the source directory untouched', { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bend2-io-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'Main.bend');
  // An IO main runs a failing effect if executed; import-only checking passes.
  const source = 'import Base\n\ndef main() -> IO(Unit):\n  IO.die(Unit, 23, "LSP MUST NOT RUN MAIN")\n';
  await fs.writeFile(file, source);
  const result = await checkDocument(TextDocument.create(pathToFileURL(file).href, 'bend2', 1, source), settings, (file) => fs.readFile(file, 'utf8'));
  assert.equal(result.status, 'passed', result.message);
  assert.deepEqual(await fs.readdir(directory), ['Main.bend']);
  assert.equal(await fs.readFile(file, 'utf8'), source);
});

test('project rename preserves bend-tensor proofs in a disposable checkout', { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bend2-rename-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.cp(root, directory, { recursive: true, filter: (file) => !['.git', '.build'].includes(path.basename(file)) });
  const server = await startServer(pathToFileURL(directory).href, settings);
  t.after(() => server.stop());
  const tensor = path.join(directory, 'Tensor.bend');
  const uri = pathToFileURL(tensor).href;
  const text = await fs.readFile(tensor, 'utf8');
  await server.open(uri, text);
  const edit = await server.connection.sendRequest('textDocument/rename', {
    textDocument: { uri }, position: position(text, 'type Tensor', 7), newName: 'DenseTensor'
  });
  assert.ok(edit.documentChanges.length >= 5);
  for (const change of edit.documentChanges) {
    const file = require('node:url').fileURLToPath(change.textDocument.uri);
    const old = TextDocument.create(change.textDocument.uri, 'bend2', 1, await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, TextDocument.applyEdits(old, change.edits));
  }
  for (const name of ['PROOF.bend', 'examples/Smoke.bend']) {
    const file = path.join(directory, name);
    const document = TextDocument.create(pathToFileURL(file).href, 'bend2', 1, await fs.readFile(file, 'utf8'));
    const result = await checkDocument(document, settings, (file) => fs.readFile(file, 'utf8'));
    assert.equal(result.status, 'passed', result.message);
  }
});
