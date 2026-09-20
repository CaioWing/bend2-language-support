'use strict';
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
function expandHome(value = 'bend') {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
// A dedicated process group also stops children of the Bend shell launcher.
function runProcess(executable, args, { timeout = 20000, maxOutput = 1024 * 1024, signal, cwd } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ cancelled: true, output: '' });
    let child, timer;
    let timedOut = false, outputTooLarge = false, size = 0;
    const chunks = [];
    const stop = () => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') child.kill(); }
    };
    const finish = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ ...value, output: Buffer.concat(chunks).toString('utf8'), timedOut, outputTooLarge, cancelled: Boolean(signal?.aborted) });
    };
    try {
      child = spawn(expandHome(executable), args, {
        cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        env: { ...process.env, BEND_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) { finish({ error }); return; }
    const append = (chunk) => {
      size += chunk.length;
      if (size > maxOutput) { outputTooLarge = true; stop(); }
      else chunks.push(chunk);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => finish({ error }));
    child.once('close', (code) => finish({ code }));
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  });
}
module.exports = { expandHome, runProcess };
