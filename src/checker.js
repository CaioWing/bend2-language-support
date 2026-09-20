'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { parseDocument, resolveLocalImport } = require('./symbols');
const { containsLaw, samePath, replaceGeneratedNames } = require('./check-plan');
const { runProcess } = require('./process');
const { compilerDiagnostics, diagnosticRange, fallbackMessage } = require('./diagnostics');

// Copy the local graph once, preserving sharing and unsaved buffers.
// Never create check files in the user's project or execute its main.
async function checkDocument(document, settings, sourceForFile, signal) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bend2-check-'));
  const files = new Map();
  const replacements = [];
  let bytes = 0;
  let companionUsed = false;
  const original = fileURLToPath(document.uri);
  const problem = (code, message) => ({ status: 'failed', message, diagnostics: [{
    range: diagnosticRange(document, 0), message, code, source: 'Bend 2', severity: 2
  }] });
  try {
    const snapshot = async (file) => {
      signal?.throwIfAborted();
      file = path.resolve(file);
      if (files.has(file)) return files.get(file);
      if (files.size >= 512) throw new Error('Local import graph exceeds 512 modules.');
      const name = `Module${files.size}.bend`;
      files.set(file, name);
      replacements.push([name.slice(0, -5), path.basename(file, '.bend')]);
      const source = samePath(file, original) ? document.getText() : await sourceForFile(file);
      bytes += Buffer.byteLength(source);
      if (bytes > 32 * 1024 * 1024) throw new Error('Local import graph exceeds 32 MiB.');
      const lines = source.split('\n');
      for (const imported of parseDocument(source).imports) {
        const target = resolveLocalImport(file, imported.path);
        if (target) {
          const replacement = await snapshot(target);
          lines[imported.line] = lines[imported.line].replace(imported.path, `./${replacement}`);
        }
      }
      const rewritten = lines.join('\n').replace(/^(\s+import\s+")([^"\n]+)(")/gm,
        (all, prefix, host, suffix) => host.startsWith('.')
          ? `${prefix}${path.resolve(path.dirname(file), host).replaceAll('\\', '/')}${suffix}` : all);
      await fs.writeFile(path.join(directory, name), rewritten, { flag: 'wx', mode: 0o600 });
      return name;
    };
    let entry = original;
    if (settings.lint?.lawsThroughProof !== false && path.basename(original) === 'LAWS.bend' && containsLaw(document.getText())) {
      const proof = path.join(path.dirname(original), 'PROOF.bend');
      try {
        const source = await sourceForFile(proof);
        companionUsed = parseDocument(source).imports.some((item) => {
          const target = resolveLocalImport(proof, item.path);
          return target && samePath(target, original);
        });
        if (companionUsed) entry = proof;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const target = await snapshot(entry);
    const wrapper = path.join(directory, 'Check.bend');
    await fs.writeFile(wrapper, `import ./${target} as CheckTarget\n`, { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    const result = await runProcess(settings.executablePath || 'bend', [wrapper], {
      cwd: path.dirname(original), timeout: settings.lint?.timeout || 20000, signal
    });
    if (result.cancelled) return { status: 'cancelled', diagnostics: [] };
    if (result.error) return problem('compiler-unavailable', `Could not run Bend: ${result.error.message}. Configure bend2.executablePath.`);
    if (result.timedOut) return problem('compiler-timeout', 'Bend check timed out and was stopped.');
    if (result.outputTooLarge) return problem('compiler-output-limit', 'Bend output exceeded 1 MiB and was stopped.');
    if (result.code === 0) return { status: 'passed', diagnostics: [] };
    const output = replaceGeneratedNames(result.output, replacements.sort((a, b) => b[0].length - a[0].length));
    return { status: 'failed', message: fallbackMessage(output), diagnostics: compilerDiagnostics(document, output, { companionUsed }) };
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled', diagnostics: [] };
    return problem('check-unavailable', `Could not check Bend source: ${error.message}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { checkDocument };
