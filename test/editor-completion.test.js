'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const configuration = require('../language-configuration.json');

// The editor skips the trigger-character path when its language word extends
// to the cursor (SuggestModel / LineContext.shouldAutoTrigger). A namespace dot
// must be a separator even though the Bend parser accepts dots inside names.
function wordAtEnd(text) {
  const words = [...text.matchAll(new RegExp(configuration.wordPattern, 'g'))];
  return words.find((word) => word.index + word[0].length === text.length)?.[0];
}
test('namespace dots trigger member completion instead of continuing the previous word', () => {
  for (const source of ['b.', 'T.', 'T.Cell.', 'F32.']) assert.equal(wordAtEnd(source), undefined, source);
  assert.equal(wordAtEnd('b.example'), 'example');
  assert.equal(wordAtEnd('T.Cell.new'), 'new');
  assert.equal(wordAtEnd('value_name'), 'value_name');
  assert.equal(wordAtEnd('1.25'), '1.25');
  assert.equal(wordAtEnd('42n'), '42n');
});
