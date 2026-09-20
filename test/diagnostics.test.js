'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanCompilerOutput,
  fallbackMessage,
  parseCompilerOutput,
  parseTodoCount
} = require('../src/diagnostics');

test('parses a Bend 2 type error and its one-based source line', () => {
  const output = `Error:
- expected : ../Tensor.Tensor<3n, 2n>
- observed : ../Tensor.Tensor<4n, 2n>
Location: InvalidMatMul.main
6 | def main() -> T.Tensor<2n, 2n>:
7>|   MatMul.matmul(2n, 3n, 2n, a, b)
8 |`;

  assert.deepEqual(parseCompilerOutput(output), [{
    line: 6,
    sourceText: '  MatMul.matmul(2n, 3n, 2n, a, b)',
    location: 'InvalidMatMul.main',
    message: '- expected : ../Tensor.Tensor<3n, 2n>\n- observed : ../Tensor.Tensor<4n, 2n>\nLocation: InvalidMatMul.main'
  }]);
});

test('parses a syntax error with an empty Location name', () => {
  const output = `Error:
- expected : a name
- observed : '>'
Location:
1>| def main( -> U32:
2 |   1`;

  const [diagnostic] = parseCompilerOutput(output);
  assert.equal(diagnostic.line, 0);
  assert.equal(diagnostic.location, '');
  assert.match(diagnostic.message, /expected : a name/);
});

test('removes the launcher migration notice', () => {
  const output = `Bend's installer changed. Update with: curl -fsSL https://bend-lang.com/install.sh | sh
Error:
- message  : bad term
Location: main
2>|   bad`;
  assert.doesNotMatch(cleanCompilerOutput(output), /installer changed/);
  assert.equal(parseCompilerOutput(output)[0].line, 1);
});

test('recognizes Bend proof-hole summaries without source locations', () => {
  const output = `Error: 6 TODOs found.\nThe code is incomplete, and not a valid proof yet.`;
  assert.equal(parseTodoCount(output), 6);
  assert.equal(parseTodoCount('Error: 1 TODO found.\nThe code is incomplete.'), 1);
  assert.equal(parseTodoCount('Error:\n- expected : Nat'), undefined);
});

test('provides bounded fallback output', () => {
  assert.equal(fallbackMessage('plain failure'), 'plain failure');
  assert.equal(fallbackMessage('abcdef', 3), 'abc…');
});
