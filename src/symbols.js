'use strict';

const path = require('node:path');

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
  return parsed.declarations.find((item) => item.name === name);
}

module.exports = {
  declarationAt,
  parseDocument,
  resolveLocalImport
};
