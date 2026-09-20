'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runProcess } = require('../src/process');
test('process output, timeout, cancellation, missing compiler and literal arguments', async () => {
  const literal = '$(touch /tmp/should-not-exist); echo unsafe';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.output, literal);
  assert.equal(result.code, 0);
  assert.equal((await runProcess('/nonexistent-bend2-test', [])).error.code, 'ENOENT');
  assert.equal((await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 })).timedOut, true);
  assert.equal((await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxOutput: 100 })).outputTooLarge, true);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).cancelled, true);
});
