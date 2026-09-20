'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  callContext,
  completionContext,
  parameterList,
  visibleBindings
} = require('../src/language-service');

test('finds function parameters and local Bend bindings before the cursor', () => {
  const source = `def calculate(x: U32, +y: U32) -> U32:
  pair = (x, y)
  case Some{value}:
    result : U32 = value
    result
`;
  const bindings = visibleBindings(source, { line: 4, character: 10 });
  const byName = new Map(bindings.map((item) => [item.name, item]));

  assert.equal(byName.get('x').detail, 'parameter: U32');
  assert.equal(byName.get('x').type, 'U32');
  assert.equal(byName.get('x').character, 14);
  assert.equal(byName.get('y').detail, 'parameter: U32');
  assert.equal(byName.get('pair').detail, 'local binding');
  assert.equal(byName.get('value').detail, 'pattern binding');
  assert.equal(byName.get('result').detail, 'local binding: U32');
  assert.equal(byName.get('result').type, 'U32');
  assert.equal(byName.has('Some'), false);
});

test('does not treat Nat pattern syntax as local names', () => {
  const source = `def loop(n: Nat) -> Nat:
  match n:
    case 1n+p:
      p
`;
  const names = visibleBindings(source, { line: 3, character: 7 }).map((item) => item.name);
  assert.deepEqual(names.sort(), ['n', 'p']);
});

test('recognizes qualified completion and nested call arguments', () => {
  const source = `def main() -> U32:
  U32.ad
  combine(one, nested(a, b), `;
  const completion = completionContext(source, { line: 1, character: 8 });
  const call = callContext(source, { line: 2, character: 28 });

  assert.equal(completion.qualifier, 'U32');
  assert.equal(completion.memberPrefix, 'ad');
  const nestedCompletion = completionContext('  Module.Math.ad', { line: 0, character: 16 });
  assert.equal(nestedCompletion.qualifier, 'Module.Math');
  assert.equal(nestedCompletion.memberPrefix, 'ad');
  assert.deepEqual(call, { name: 'combine', activeParameter: 2 });
});

test('splits signature parameters without splitting nested generic arguments', () => {
  assert.deepEqual(
    parameterList('def map(f: A -> B, xs: List<&2, A>) -> List<&2, B>:'),
    ['f: A -> B', 'xs: List<&2, A>']
  );
});

test('case scopes do not leak and qualified constructors keep exact binding locations', () => {
  const source = 'def f(n: Nat) -> Nat:\n  match n:\n    case 1n+p:\n      T.Cell.new{x, xs} = value\n      x\n    case 0n:\n      n\n';
  const inside = visibleBindings(source, { line: 4, character: 7 });
  assert.equal(inside.find((item) => item.name === 'x').character, 17);
  assert.equal(inside.some((item) => item.name === 'new'), false);
  const outside = visibleBindings(source, { line: 6, character: 7 }).map((item) => item.name);
  assert.deepEqual(outside, ['n']);
});

test('signatures ignore commas in strings, comments, constructors, lists and types', () => {
  for (const expression of ['f("a,b", ', 'f(Cell{a, b}, ', 'f([a, b], ', 'f(Tensor<m, n>, ', 'f(g(a, b), # ,\n  ']) {
    const lines = expression.split('\n');
    assert.deepEqual(callContext(expression, { line: lines.length - 1, character: lines.at(-1).length }), { name: 'f', activeParameter: 1 });
  }
  assert.deepEqual(parameterList('def f(xs: List<A -> B>, n: Nat):'), ['xs: List<A -> B>', 'n: Nat']);
});

test('multiline parameters and erased type parameters are visible', () => {
  const source = 'def f(\n  -A: Data,\n  x: A\n) -> A:\n  x\n';
  const bindings = visibleBindings(source, { line: 4, character: 3 });
  assert.equal(bindings.find((item) => item.name === 'x').line, 2);
  assert.equal(bindings.find((item) => item.name === 'A').type, 'Data');
});
