'use strict';
const { fileURLToPath } = require('node:url');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { checkDocument } = require('./checker');

function registerLint(connection, documents, getSettings, sourceForFile) {
  const jobs = new Map();
  const versions = new Map();
  const timers = new Map();
  // Serialize checks so opening a project cannot start an unbounded compiler fleet.
  let queue = Promise.resolve();
  const cancel = (uri) => {
    clearTimeout(timers.get(uri));
    timers.delete(uri);
    jobs.get(uri)?.abort();
    jobs.delete(uri);
  };
  const check = async (document) => {
    if (!document.uri.startsWith('file:')) return { status: 'skipped' };
    cancel(document.uri);
    const controller = new AbortController();
    jobs.set(document.uri, controller);
    const version = document.version;
    const snapshot = document.getText();
    const run = async () => {
      if (controller.signal.aborted) return { status: 'cancelled' };
      const settings = await getSettings(document.uri);
      const frozen = TextDocument.create(document.uri, 'bend2', version, snapshot);
      const buffers = new Map(documents.all().filter((doc) => doc.uri.startsWith('file:')).map((doc) => [fileURLToPath(doc.uri), doc.getText()]));
      const result = await checkDocument(frozen, settings, (file) => buffers.has(file) ? buffers.get(file) : sourceForFile(file), controller.signal);
      if (jobs.get(document.uri) !== controller || documents.get(document.uri)?.version !== version) return { status: 'cancelled' };
      jobs.delete(document.uri);
      connection.sendDiagnostics({ uri: document.uri, version, diagnostics: result.diagnostics || [] });
      return { status: result.status, message: result.message };
    };
    const result = queue.then(run).catch((error) => ({ status: 'failed', message: error.message }));
    queue = result;
    return result;
  };
  const schedule = async (document, reason) => {
    if (!document.uri.startsWith('file:')) return;
    const version = document.version;
    const settings = await getSettings(document.uri);
    if (documents.get(document.uri)?.version !== version) return;
    const lint = settings.lint || {};
    if (lint.run === 'off' || (reason === 'open' && lint.onOpen === false)) return;
    if (reason === 'change' && lint.run !== 'onType') return;
    clearTimeout(timers.get(document.uri));
    timers.set(document.uri, setTimeout(() => { timers.delete(document.uri); void check(document); }, reason === 'change' ? lint.delay : 0));
  };
  documents.onDidOpen(({ document }) => { versions.set(document.uri, document.version); void schedule(document, 'open'); });
  documents.onDidChangeContent(({ document }) => {
    if (versions.get(document.uri) === document.version) return;
    versions.set(document.uri, document.version);
    // Invalidate every running graph, including when an imported buffer changes.
    for (const open of documents.all()) {
      cancel(open.uri);
      connection.sendDiagnostics({ uri: open.uri, diagnostics: [] });
      void schedule(open, 'change');
    }
  });
  documents.onDidSave(() => {
    for (const open of documents.all()) void schedule(open, 'save');
  });
  documents.onDidClose(({ document }) => {
    versions.delete(document.uri);
    cancel(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    for (const open of documents.all()) { cancel(open.uri); void schedule(open, 'change'); }
  });
  connection.onRequest('bend2/check', async ({ uri }) => {
    const document = documents.get(uri);
    return document ? check(document) : { status: 'skipped', message: 'Open a Bend file first.' };
  });
  return {
    reset() {
      for (const document of documents.all()) {
        cancel(document.uri);
        connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
        void schedule(document, 'open');
      }
    },
    async dispose() { for (const uri of [...jobs.keys(), ...timers.keys()]) cancel(uri); await queue; }
  };
}
module.exports = { registerLint };
