'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { declarationAt, parseDocument, resolveLocalImport } = require('../src/symbols');

test('finds imports, declarations, constructors, and documentation', () => {
  const source = `import Base
import ./math.bend as M

# A reusable shape.
type Shape is Data:
  Circle{radius: U32}
  Shape.square{side: U32}

def area(x: Shape) -> U32:
  0

law area_non_negative:
  Unit
`;
  const parsed = parseDocument(source);

  assert.deepEqual(parsed.imports[1], { path: './math.bend', alias: 'M', line: 1 });
  assert.equal(declarationAt(parsed, 'Shape').documentation, 'A reusable shape.');
  assert.equal(declarationAt(parsed, 'Circle').kind, 'constructor');
  assert.equal(declarationAt(parsed, 'Shape.square').kind, 'constructor');
  assert.equal(declarationAt(parsed, 'area').kind, 'def');
  assert.equal(declarationAt(parsed, 'area_non_negative').kind, 'law');
});

test('resolves only relative Bend module paths', () => {
  const current = path.join('/workspace', 'src', 'main.bend');
  assert.equal(resolveLocalImport(current, '../lib.bend'), path.join('/workspace', 'lib.bend'));
  assert.equal(resolveLocalImport(current, 'Base'), undefined);
  assert.equal(resolveLocalImport(current, '0xabc/main.bend'), undefined);
});
