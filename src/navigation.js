'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { Range, Location, ResponseError, ErrorCodes, LSPErrorCodes, SymbolKind } = require('vscode-languageserver/node');
const { parseDocument, declarationAt, resolveLocalImport } = require('./symbols');
const { visibleBindings, KEYWORDS } = require('./language-service');
const { tokens, codeOnly } = require('./lexical');

const excluded = new Set(['.git', '.bend', 'node_modules', 'target', 'dist', 'build', '.venv']);
function tokenRange(token) { return Range.create(token.line, token.character, token.line, token.character + token.name.length); }
function tokenAt(document, position) {
  return tokens(document.getText()).find((item) => item.line === position.line && item.character <= position.character && item.character + item.name.length >= position.character);
}
function registerNavigation(connection, documents, getFolders, source) {
  async function project(token) {
    const result = new Map();
    let bytes = 0, entriesSeen = 0;
    const add = async (uri) => {
      if (result.has(uri)) return;
      token?.throwIfCancellationRequested?.();
      if (token?.isCancellationRequested) throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled.');
      if (result.size >= 1024) throw new Error('Workspace exceeds 1024 Bend files. Open a smaller folder.');
      const text = await source(uri);
      bytes += Buffer.byteLength(text);
      if (bytes > 32 * 1024 * 1024) throw new Error('Workspace Bend sources exceed 32 MiB.');
      const open = documents.get(uri);
      result.set(uri, open || TextDocument.create(uri, 'bend2', 0, text));
    };
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++entriesSeen > 20000) throw new Error('Workspace exceeds 20000 entries. Open a smaller folder.');
        if (excluded.has(entry.name) || entry.name.startsWith('Bend2Vscode')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.endsWith('.bend')) await add(pathToFileURL(file).href);
        else if (entry.isSymbolicLink()) throw new Error('Workspace contains symbolic links; project rename requires regular files.');
      }
    };
    for (const folder of getFolders()) if (folder.uri.startsWith('file:')) await walk(fileURLToPath(folder.uri));
    for (const document of documents.all()) if (document.uri.startsWith('file:')) await add(document.uri);
    return result;
  }
  async function identity(document, token, seen = new Set()) {
    if (!token) return undefined;
    const key = `${document.uri}\0${token.name}`;
    if (seen.has(key) || seen.size > 32) return undefined;
    seen.add(key);
    const parsed = parseDocument(document.getText());
    if (parsed.imports.some((item) => item.line === token.line)) return undefined;
    const binding = visibleBindings(document.getText(), { line: token.line, character: token.character }).find((item) => item.name === token.name)
      || visibleBindings(document.getText(), { line: token.line + 1, character: 0 }).find((item) => item.name === token.name && item.line === token.line && item.character === token.character);
    if (binding) return { uri: document.uri, name: token.name, local: true, line: binding.line, character: binding.character };
    const dot = token.name.indexOf('.');
    if (dot > 0) {
      const imported = parsed.imports.find((item) => item.alias === token.name.slice(0, dot));
      const file = imported && resolveLocalImport(fileURLToPath(document.uri), imported.path);
      if (file) {
        const uri = pathToFileURL(file).href;
        const text = await source(uri);
        const name = token.name.slice(dot + 1);
        const declaration = declarationAt(parseDocument(text), name);
        if (declaration) return { uri, name, declaration };
        return identity(TextDocument.create(uri, 'bend2', 0, text), { name, line: -1, character: 0 }, seen);
      }
    }
    const declaration = declarationAt(parsed, token.name);
    return declaration ? { uri: document.uri, name: declaration.name, declaration } : undefined;
  }
  const same = (a, b) => a && b && a.uri === b.uri && a.name === b.name && a.local === b.local && (!a.local || (a.line === b.line && a.character === b.character));
  async function references(params, cancellation) {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { locations: [] };
    const selected = tokenAt(document, params.position);
    const target = await identity(document, selected);
    if (!target) return { locations: [] };
    const sources = target.local ? new Map([[document.uri, document]]) : await project(cancellation);
    const locations = [];
    for (const candidate of sources.values()) {
      const parsed = parseDocument(candidate.getText());
      for (const token of tokens(candidate.getText())) {
        if (token.name !== target.name && !token.name.endsWith('.' + target.name)) continue;
        if (!same(target, await identity(candidate, token))) continue;
        const isDeclaration = target.local
          ? token.line === target.line && token.character === target.character
          : parsed.declarations.some((item) => item.line === token.line && item.character === token.character);
        if (params.context?.includeDeclaration === false && isDeclaration) continue;
        const character = token.character + token.name.length - target.name.length;
        locations.push(Location.create(candidate.uri, Range.create(token.line, character, token.line, character + target.name.length)));
      }
    }
    return { locations, target, selected, sources };
  }
  connection.onReferences(async (params, token) => (await references(params, token)).locations);
  connection.onDocumentHighlight(async (params, token) => (await references(params, token)).locations
    .filter((item) => item.uri === params.textDocument.uri).map((item) => ({ range: item.range, kind: 1 })));
  const renameTarget = async (params) => {
    const document = documents.get(params.textDocument.uri);
    const selected = document && tokenAt(document, params.position);
    const target = document && await identity(document, selected);
    if (!target || target.local || target.name.includes('.') || target.name === 'main') {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Safe rename supports simple project declarations. Local binders, main, Base and dotted declaration names are not renamed.');
    }
    return { target, selected };
  };
  connection.onPrepareRename(async (params) => {
    const { target, selected } = await renameTarget(params);
    return { range: Range.create(selected.line, selected.character + selected.name.length - target.name.length, selected.line, selected.character + selected.name.length), placeholder: target.name };
  });
  connection.onRenameRequest(async (params, token) => {
    const { target } = await renameTarget(params);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.newName) || KEYWORDS.includes(params.newName) || params.newName === '_' || params.newName === 'main') {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Choose a non-reserved Bend identifier.');
    }
    if (target.declaration.kind === 'constructor' && !/^[A-Z]/.test(params.newName)) throw new ResponseError(ErrorCodes.InvalidParams, 'Constructor names must start with an uppercase letter.');
    const { locations, sources } = await references({ ...params, context: { includeDeclaration: true } }, token);
    if (!sources?.has(target.uri)) throw new ResponseError(ErrorCodes.InvalidParams, 'The declaration is outside the workspace.');
    // Conservatively reject potential capture anywhere in this project.
    for (const candidate of sources.values()) {
      const code = codeOnly(candidate.getText());
      const lines = code.split('\n');
      const shadowed = new RegExp(`\\b${target.name}\\s*=>`).test(code)
        || lines.some((line, index) => visibleBindings(code, { line: index, character: line.length }).some((binding) => binding.name === target.name));
      if (shadowed) throw new ResponseError(ErrorCodes.InvalidParams, 'This declaration is shadowed by a local binder; rename is refused to avoid ambiguous edits.');
      if (params.newName !== target.name && tokens(candidate.getText()).some((item) => item.name.split('.').includes(params.newName))) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'This name already occurs in the project and may capture another binding.');
      }
    }
    const edits = new Map();
    for (const location of locations) {
      if (!edits.has(location.uri)) edits.set(location.uri, []);
      edits.get(location.uri).push({ range: location.range, newText: params.newName });
    }
    return { documentChanges: [...edits].map(([uri, edits]) => ({ textDocument: { uri, version: documents.get(uri)?.version ?? null }, edits })) };
  });
  connection.onWorkspaceSymbol(async ({ query }, token) => {
    const result = [];
    for (const document of (await project(token)).values()) {
      for (const item of parseDocument(document.getText()).declarations) {
        if (item.name.toLowerCase().includes(query.toLowerCase())) result.push({ name: item.name, kind: item.kind === 'def' ? SymbolKind.Function : SymbolKind.Struct, location: Location.create(document.uri, tokenRange({ ...item, name: item.name })) });
        if (result.length >= 500) return result;
      }
    }
    return result;
  });
  connection.onFoldingRanges(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const lines = codeOnly(document.getText()).split('\n');
    const folds = [];
    const stack = [];
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const indent = line.search(/\S/);
      while (stack.length && indent <= stack.at(-1).indent) {
        const block = stack.pop();
        if (index - 1 > block.startLine) folds.push({ startLine: block.startLine, endLine: index - 1 });
      }
      if (line.trimEnd().endsWith(':')) stack.push({ indent, startLine: index });
    });
    for (const block of stack) if (lines.length - 1 > block.startLine) folds.push({ startLine: block.startLine, endLine: lines.length - 1 });
    return folds;
  });
  connection.onSelectionRanges(({ textDocument, positions }) => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const parsed = parseDocument(document.getText());
    return positions.map((position) => {
      const token = tokenAt(document, position);
      const whole = { range: Range.create(0, 0, parsed.lines.length - 1, parsed.lines.at(-1).length) };
      const declaration = parsed.declarations.findLast((item) => item.line <= position.line && item.endLine >= position.line);
      const parent = declaration ? { range: Range.create(declaration.line, 0, declaration.endLine, parsed.lines[declaration.endLine].length), parent: whole } : whole;
      const line = { range: Range.create(position.line, 0, position.line, parsed.lines[position.line].length), parent };
      return token ? { range: tokenRange(token), parent: line } : line;
    });
  });
}
module.exports = { registerNavigation };
