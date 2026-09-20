'use strict';
const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { expandHome } = require('./process');
let client;

async function activate(context) {
  const output = vscode.window.createOutputChannel('Bend 2');
  const server = { module: context.asAbsolutePath('src/server.js'), transport: TransportKind.ipc };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.bend');
  client = new LanguageClient('bend2LanguageServer', 'Bend 2 Language Server', { run: server, debug: server }, {
    documentSelector: [{ language: 'bend2', scheme: 'file' }],
    synchronize: { configurationSection: 'bend2', fileEvents: watcher },
    outputChannel: output
  });
  context.subscriptions.push(output, watcher, client);
  await client.start();
  const current = () => {
    const document = vscode.window.activeTextEditor?.document;
    return document?.languageId === 'bend2' && document.uri.scheme === 'file' ? document : undefined;
  };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(check) Bend 2';
  status.command = 'bend2.checkFile';
  status.tooltip = 'Check current Bend file and its unsaved local imports';
  const update = () => current() ? status.show() : status.hide();
  const pages = new Map();
  const showDocumentation = async (guide = false) => {
    const editor = vscode.window.activeTextEditor;
    const document = current();
    let query = guide ? 'guide' : editor?.document.getText(editor.selection).trim();
    if (!guide && !query && document) {
      const range = document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_.]*/);
      query = range ? document.getText(range) : '';
    }
    if (!guide) {
      query = await vscode.window.showInputBox({ title: 'Bend Base documentation', prompt: 'Base name; leave empty for the complete library', value: query || '', placeHolder: 'F32.add, Tensor, IO, List…' });
      if (query === undefined) return;
    }
    const uri = vscode.Uri.from({ scheme: 'bend2-docs', path: guide ? '/Guide.md' : `/${encodeURIComponent(query || 'Base')}.bend`, query: encodeURIComponent(document?.uri.toString() || '') });
    const text = await client.sendRequest('bend2/documentation', { uri: document?.uri.toString(), query: query.trim() });
    pages.set(uri.toString(), text);
    changed.fire(uri);
    const page = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(page, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  };
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(
    status, changed,
    vscode.workspace.registerTextDocumentContentProvider('bend2-docs', {
      onDidChange: changed.event,
      provideTextDocumentContent: (uri) => pages.get(uri.toString()) || ''
    }),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.commands.registerCommand('bend2.checkFile', async () => {
      const document = current();
      if (!document) return vscode.window.showInformationMessage('Open a Bend (.bend) file first.');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking Bend' }, async () => {
        const result = await client.sendRequest('bend2/check', { uri: document.uri.toString() });
        if (result.status === 'passed') vscode.window.showInformationMessage('Bend check passed.');
        else if (result.status === 'failed') {
          output.appendLine(result.message || 'Bend check failed.');
          vscode.window.showErrorMessage('Bend check failed. See Problems.');
        }
      });
    }),
    vscode.commands.registerCommand('bend2.runFile', async () => {
      const document = current();
      if (!document) return vscode.window.showInformationMessage('Open a Bend (.bend) file first.');
      // Run uses disk: save Bend buffers first, including imported modules.
      for (const open of vscode.workspace.textDocuments) {
        if (open.languageId === 'bend2' && open.uri.scheme === 'file' && open.isDirty && !await open.save()) return;
      }
      const executable = expandHome(vscode.workspace.getConfiguration('bend2', document.uri).get('executablePath', 'bend'));
      const task = new vscode.Task({ type: 'bend2', file: document.uri.fsPath },
        vscode.workspace.getWorkspaceFolder(document.uri) || vscode.TaskScope.Workspace,
        `Run ${path.basename(document.uri.fsPath)}`, 'Bend 2',
        new vscode.ProcessExecution(executable, [document.uri.fsPath], { cwd: path.dirname(document.uri.fsPath) }));
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
      await vscode.tasks.executeTask(task);
    }),
    vscode.commands.registerCommand('bend2.showBaseDocumentation', () => showDocumentation()),
    vscode.commands.registerCommand('bend2.showGuide', () => showDocumentation(true))
  );
  update();
}
async function deactivate() { if (client) { await client.stop(); client = undefined; } }
module.exports = { activate, deactivate };
