'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  containsLaw,
  generatedNameReplacements,
  replaceGeneratedNames,
  rewriteCompanionImport
} = require('../src/check-plan');

test('recognizes a top-level Bend law', () => {
  assert.equal(containsLaw('import Base\n\nlaw identity:\n  Unit\n'), true);
  assert.equal(containsLaw('import Base\n\ndef identity() -> Unit:\n  Unit{}\n'), false);
});

test('rewrites only the proof import that resolves to the open law file', () => {
  const directory = path.resolve('/workspace/project');
  const proofPath = path.join(directory, 'PROOF.bend');
  const lawsPath = path.join(directory, 'LAWS.bend');
  const proof = [
    'import Base',
    'import ./LAWS.bend as Laws',
    'import ./Other.bend as Other',
    '',
    'def Laws.identity(x):',
    '  {==}',
    ''
  ].join('\n');

  const rewritten = rewriteCompanionImport(
    proof,
    proofPath,
    lawsPath,
    'Bend2VscodeSource_123.bend'
  );

  assert.equal(rewritten.replaced, true);
  assert.match(rewritten.source, /import \.\/Bend2VscodeSource_123\.bend as Laws/);
  assert.match(rewritten.source, /import \.\/Other\.bend as Other/);
});

test('does not claim a companion when PROOF does not import the law file', () => {
  const directory = path.resolve('/workspace/project');
  const rewritten = rewriteCompanionImport(
    'import ./Other.bend as Laws\n',
    path.join(directory, 'PROOF.bend'),
    path.join(directory, 'LAWS.bend'),
    'Bend2VscodeSource_123.bend'
  );
  assert.equal(rewritten.replaced, false);
});

test('maps generated module names back to LAWS and PROOF', () => {
  const replacements = generatedNameReplacements(
    'Bend2VscodeSource_123.bend',
    'LAWS.bend',
    'Bend2VscodeProof_123.bend'
  );
  const output = replaceGeneratedNames(
    'Location: Bend2VscodeSource_123.foo\nContext: Bend2VscodeProof_123',
    replacements
  );
  assert.equal(output, 'Location: LAWS.foo\nContext: PROOF');
});
