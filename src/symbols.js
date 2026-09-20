'use strict';

const path = require('node:path');
const { codeOnly } = require('./lexical');

function parseDocument(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const declarations = [];
  const imports = [];
  let comments = [];
  let activeType = false;

  for (let line = 0; line < lines.length; line += 1) {
    const value = lines[line];
    const trimmed = value.trim();

    if (/^\s*#/.test(value)) {
      comments.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }

    if (trimmed === '') {
      comments = [];
      continue;
    }

    const importMatch = value.match(/^import\s+([^\s]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/);
    if (importMatch) {
      imports.push({
        path: importMatch[1],
        alias: importMatch[2] || (importMatch[1] === 'Base' ? 'Base' : undefined),
        line
      });
      comments = [];
      activeType = false;
      continue;
    }

    const declaration = value.match(/^(?:@unsafe\s+)?(def|type|law)\s+([A-Za-z_][A-Za-z0-9_.]*)/);
    if (declaration) {
      declarations.push({
        kind: declaration[1],
        name: declaration[2],
        line,
        character: value.indexOf(declaration[2]),
        signature: trimmed,
        documentation: comments.join('\n')
      });
      activeType = declaration[1] === 'type';
      comments = [];
      continue;
    }

    const constructor = activeType && value.match(/^\s+([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\{/);
    if (constructor) {
      declarations.push({
        kind: 'constructor',
        name: constructor[1],
        line,
        character: value.indexOf(constructor[1]),
        signature: trimmed,
        documentation: comments.join('\n')
      });
      comments = [];
      continue;
    }

    if (!/^\s/.test(value)) {
      activeType = false;
    }
    comments = [];
  }

  const code = codeOnly(text).split('\n');
  for (const item of declarations) {
    let headerEnd = item.line;
    if (item.kind === 'def') {
      while (headerEnd + 1 < lines.length && !code[headerEnd].trimEnd().endsWith(':') && !/^(def|law|type|import)\b/.test(code[headerEnd + 1])) headerEnd += 1;
    }
    let end = headerEnd + 1;
    const indent = lines[item.line].search(/\S/);
    while (end < lines.length && (!code[end]?.trim() || lines[end].search(/\S/) > indent)) end += 1;
    item.endLine = Math.max(item.line, end - 1);
    while (item.endLine > item.line && !lines[item.endLine].trim()) item.endLine -= 1;
    // Headers can span several lines. Keep source locations on the first line.
    if (item.kind === 'def' && !code[item.line].trimEnd().endsWith(':')) {
      const header = headerEnd;
      item.signature = lines.slice(item.line, header + 1).map((line) => line.trim()).join(' ');
      item.headerEndLine = header;
    }
    if (item.kind === 'law') {
      const body = lines.slice(item.line + 1, item.endLine + 1).filter((line) => codeOnly(line).trim());
      const binders = [];
      while (body.length && /^\s*for\s+/.test(body[0])) binders.push(body.shift().trim().replace(/^for\s+/, ''));
      item.callSignature = `def ${item.name}(${binders.join(', ')}) -> ${body.map((line) => line.trim()).join(' ')}:`;
      item.signature = [item.signature, ...lines.slice(item.line + 1, item.endLine + 1)].join('\n');
    }
  }
  return { declarations, imports, lines };
}

function resolveLocalImport(currentFile, importPath) {
  if (!currentFile || !importPath || importPath === 'Base' || importPath.startsWith('0x')) {
    return undefined;
  }
  if (!importPath.startsWith('.')) {
    return undefined;
  }
  return path.resolve(path.dirname(currentFile), importPath);
}

function declarationAt(parsed, name) {
  return parsed.declarations.find((item) => item.name === name && item.kind === 'def')
    || parsed.declarations.find((item) => item.name === name);
}

module.exports = {
  declarationAt,
  parseDocument,
  resolveLocalImport
};
