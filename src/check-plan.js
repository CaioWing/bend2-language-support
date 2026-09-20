'use strict';

const path = require('node:path');

function containsLaw(source) {
  return /^(?:[ \t]*)law[ \t]+[A-Za-z_][A-Za-z0-9_.]*[ \t]*:/m.test(String(source));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function rewriteCompanionImport(proofSource, proofPath, lawsPath, replacementName) {
  let replaced = false;
  const source = String(proofSource).replace(
    /^([ \t]*import[ \t]+)(\.[^ \t\r\n]+)([^\r\n]*)$/gm,
    (line, prefix, importPath, suffix) => {
      const resolved = path.resolve(path.dirname(proofPath), importPath);
      if (!samePath(resolved, lawsPath)) {
        return line;
      }
      replaced = true;
      return `${prefix}./${replacementName}${suffix}`;
    }
  );
  return { source, replaced };
}

function generatedNameReplacements(sourceName, originalName, companionName) {
  const replacements = [
    [sourceName, originalName],
    [path.basename(sourceName, '.bend'), path.basename(originalName, '.bend')]
  ];
  if (companionName) {
    replacements.push(
      [companionName, 'PROOF.bend'],
      [path.basename(companionName, '.bend'), 'PROOF']
    );
  }
  return replacements;
}

function replaceGeneratedNames(output, replacements) {
  return replacements.reduce(
    (text, [generated, display]) => String(text).split(generated).join(display),
    String(output)
  );
}

module.exports = {
  containsLaw,
  generatedNameReplacements,
  replaceGeneratedNames,
  rewriteCompanionImport,
  samePath
};
