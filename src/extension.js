'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');
const {
  containsLaw,
  generatedNameReplacements,
  replaceGeneratedNames,
  rewriteCompanionImport,
  samePath
} = require('./check-plan');
const {
  cleanCompilerOutput,
  fallbackMessage,
  parseCompilerOutput,
  parseTodoCount
} = require('./diagnostics');
const {
  declarationAt,
  parseDocument,
  resolveLocalImport
} = require('./symbols');

const TEMP_PREFIX = 'Bend2Vscode';
const MAX_OUTPUT = 1024 * 1024;
let activeLintManager;

const LANGUAGE_HELP = new Map([
  ['def', ['Bend 2 definition', 'Declares a typed function. Bend performs little inference, so parameter and result annotations are normally explicit.']],
  ['type', ['Bend 2 datatype', 'Declares a datatype and its kind. Use `is Data` for reusable values or `is Type` for affine values.']],
  ['law', ['Bend 2 law', 'Declares a proposition that must be implemented by a `def` with the same qualified name.']],
  ['match', ['Pattern match', 'Inspects a parameter or a variable bound by a pattern. Bend 2 does not have an `if`; match on `True{}` and `False{}` instead.']],
  ['do', ['Monad do block', 'Sequences `bind` and `pure` operations for a monad such as `IO`, `Maybe`, or `Result`.']],
  ['Type', ['Affine kind', '`Type` is short for `Kind(&1)`: its values may be used at most once.']],
  ['Data', ['Reusable kind', '`Data` is short for `Kind(&2)`: its values may be copied when marked with `+`.']],
  ['Kind', ['Kind', '`Kind(q)` classifies types by their maximum usage quantity.']],
  ['Quant', ['Quantity kind', 'The quantities are `&0` (erased), `&1` (affine), and `&2` (reusable).']],
  ['Nat', ['Natural number', 'A machine-word natural. Literals use the `n` suffix, such as `0n` and `42n`. Recursion commonly matches `0n` and `1n+p`.']],
  ['U32', ['Unsigned 32-bit integer', 'A reusable unsigned 32-bit value. Arithmetic operators inside an annotation such as `(a + b : U32)` resolve to `U32` operations.']],
  ['F32', ['32-bit floating point', 'A reusable 32-bit floating-point value.']],
  ['IO', ['IO monad', 'Represents effectful computations. Sequence effects with `do IO<T>:`.']],
  ['Array', ['Affine array', 'An in-place array with one owner. Reads return the array alongside the element; writes rebind the array.']],
  ['List', ['List', 'A list whose quantity follows the quantity of its elements. Constructors are `Nil{}` and `Con{head, tail}`.']],
  ['Maybe', ['Optional value', 'Constructors are `None{}` and `Some{value}`.']],
  ['Result', ['Result value', 'Constructors are `Fail{error}` and `Done{value}`.']],
  ['@unsafe', ['Unsafe definition', 'Allows unrestricted recursion and places the definition outside Bend proof guarantees.']],
  ['?TODO', ['Proof hole', 'Leaves a proof goal open. `bend PROOF.bend` fails while a reachable hole remains.']],
  ['{==}', ['Reflexivity proof', 'Proves an equality when both sides compute to the same term.']]
]);

const KEYWORD_COMPLETIONS = [
  'def', 'type', 'law', 'match', 'case', 'do', 'return', 'for', 'exs', 'where',
  'import', 'as', 'is', 'Type', 'Data', 'Kind', 'Quant', 'Nat', 'U32', 'F32',
  'String', 'Bool', 'Unit', 'List', 'Array', 'Maybe', 'Result', 'IO'
];

const BASE_MEMBERS = new Map([
  ['Nat', ['double', 'add', 'sub', 'mul', 'divmod', 'div', 'mod', 'pow', 'cmp', 'is_eq', 'is_ne', 'is_lt', 'is_le', 'is_gt', 'is_ge', 'min', 'max', 'show', 'read']],
  ['U32', ['inc', 'add', 'sub', 'mul', 'div', 'mod', 'pow', 'not', 'and', 'or', 'xor', 'shl', 'shr', 'shln', 'shrn', 'cmp', 'is_eq', 'is_ne', 'is_lt', 'is_le', 'is_gt', 'is_ge', 'is_zero', 'is_even', 'min', 'max', 'clamp', 'to_nat', 'from_nat', 'show', 'read']],
  ['F32', ['to_u32', 'add', 'sub', 'mul', 'div', 'mod', 'pow', 'atan2', 'neg', 'abs', 'sqrt', 'exp', 'log', 'log2', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'floor', 'ceil', 'trunc', 'round', 'min', 'max', 'clamp', 'lerp', 'square', 'hypot', 'pi', 'from_nat', 'to_nat', 'is_eq', 'is_ne', 'is_lt', 'is_le', 'is_gt', 'is_ge', 'show', 'read']],
  ['Bool', ['not', 'and', 'or', 'xor', 'cmp', 'full_add', 'pick', 'to_u32', 'show']],
  ['String', ['append', 'cmp', 'eq', 'length', 'is_empty', 'reverse', 'order', 'is_lt', 'is_le', 'is_gt', 'is_ge', 'starts_with', 'ends_with', 'contains', 'take', 'drop', 'get', 'to_list', 'from_list', 'concat', 'join', 'split', 'lines', 'repeat', 'to_upper', 'to_lower', 'trim_start', 'trim_end', 'trim']],
  ['List', ['map', 'length', 'append', 'concat', 'reverse', 'is_empty', 'head', 'tail', 'last', 'get', 'set', 'take', 'drop', 'zip', 'range', 'replicate', 'filter', 'foldl', 'foldr', 'any', 'all', 'find', 'contains', 'sort', 'for_each', 'show']],
  ['Array', ['size', 'swap', 'clone', 'new', 'set', 'get', 'to_list', 'map']],
  ['Map', ['new', 'set', 'has', 'get', 'del', 'to_list', 'keys', 'from_list', 'union', 'size', 'values']],
  ['Set', ['new', 'add', 'has', 'del', 'size', 'to_list', 'from_list']],
  ['Maybe', ['pure', 'bind', 'default', 'is_some', 'is_none', 'map', 'or', 'show']],
  ['Result', ['pure', 'bind', 'default', 'is_done', 'is_fail', 'map']],
  ['Equal', ['cong', 'sym', 'trans']],
  ['IO', ['pure', 'bind', 'print', 'write', 'print_err', 'get_env', 'die', 'pass', 'try', 'spawn', 'sleep', 'now', 'fork', 'join']]
]);

function configuration(uri) {
  return vscode.workspace.getConfiguration('bend2', uri);
}

function expandHome(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isBendDocument(document) {
  return document && document.languageId === 'bend2' && document.uri.scheme === 'file';
}

function isGeneratedFile(document) {
  return path.basename(document.uri.fsPath).startsWith(TEMP_PREFIX);
}

async function sourceForFile(filePath) {
  const open = vscode.workspace.textDocuments.find((document) =>
    document.uri.scheme === 'file' && samePath(document.uri.fsPath, filePath)
  );
  return open ? open.getText() : fs.readFile(filePath, 'utf8');
}

function runProcess(executable, args, options = {}) {
  const timeout = options.timeout || 20000;
  const maxOutput = options.maxOutput || MAX_OUTPUT;
  let child;

  const result = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let timer;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ...value,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
        timedOut,
        outputTooLarge
      });
    };

    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      finish({ code: null, error });
      return;
    }

    if (options.onSpawn) {
      options.onSpawn(child);
    }

    const append = (target, chunk) => {
      const value = chunk.toString();
      if (stdout.length + stderr.length + value.length > maxOutput) {
        outputTooLarge = true;
        child.kill();
        return target;
      }
      return target + value;
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
  });

  return { child: () => child, result };
}

async function removeFiles(files) {
  await Promise.all(files.map(async (file) => {
    try {
      await fs.unlink(file);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }
  }));
}

function diagnosticRange(document, requestedLine) {
  if (document.lineCount === 0) {
    return new vscode.Range(0, 0, 0, 0);
  }
  const lineNumber = Math.min(Math.max(requestedLine, 0), document.lineCount - 1);
  const line = document.lineAt(lineNumber);
  const start = line.firstNonWhitespaceCharacterIndex;
  return new vscode.Range(lineNumber, start, lineNumber, line.text.length);
}

function compilerDiagnostics(document, output, context = {}) {
  const todoCount = parseTodoCount(output);
  if (todoCount !== undefined) {
    const laws = parseDocument(document.getText()).declarations.filter((item) => item.kind === 'law');
    const noCompanion = path.basename(document.uri.fsPath) === 'LAWS.bend' && !context.companionUsed;
    if (noCompanion && laws.length === todoCount) {
      return laws.map((law) => {
        const diagnostic = new vscode.Diagnostic(
          diagnosticRange(document, law.line),
          `Open law '${law.name}' was checked without its proof companion. ` +
            'The linter did not find a sibling PROOF.bend importing ./LAWS.bend, or ' +
            'bend2.lint.lawsThroughProof is disabled.',
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'Bend 2';
        diagnostic.code = 'open-law-without-proof-companion';
        return diagnostic;
      });
    }

    const route = context.companionUsed
      ? 'The check included PROOF.bend. Add any missing def Laws.<law> implementations and replace remaining ?TODO proof holes there.'
      : 'Add definitions for open laws and replace ?TODO proof holes. For LAWS.bend, provide a sibling PROOF.bend that imports ./LAWS.bend.';
    const noun = todoCount === 1 ? 'obligation' : 'obligations';
    const diagnostic = new vscode.Diagnostic(
      diagnosticRange(document, 0),
      `Bend found ${todoCount} unresolved proof ${noun}, but did not report exact source locations. ${route}`,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'Bend 2';
    diagnostic.code = 'unresolved-proof-obligations';
    return [diagnostic];
  }

  const parsed = parseCompilerOutput(output);
  if (parsed.length === 0) {
    const diagnostic = new vscode.Diagnostic(
      diagnosticRange(document, 0),
      fallbackMessage(output),
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'Bend 2';
    diagnostic.code = 'compiler-error';
    return [diagnostic];
  }

  return parsed.map((item) => {
    let line = item.line;
    let message = item.message;
    const sourceText = item.sourceText.trim();
    const targetText = line < document.lineCount ? document.lineAt(line).text.trim() : '';
    if (sourceText && sourceText !== targetText) {
      line = 0;
      message += `\nCompiler excerpt at line ${item.line + 1}: ${sourceText}`;
    }
    const diagnostic = new vscode.Diagnostic(
      diagnosticRange(document, line),
      message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'Bend 2';
    diagnostic.code = 'compiler-error';
    return diagnostic;
  });
}

class LintManager {
  constructor(collection, output, onBusyChange) {
    this.collection = collection;
    this.output = output;
    this.onBusyChange = onBusyChange;
    this.jobs = new Map();
    this.sequence = 0;
  }

  cancel(uri) {
    const key = uri.toString();
    const current = this.jobs.get(key);
    this.sequence += 1;
    if (current && current.child) {
      current.child.kill();
    }
    this.jobs.set(key, { id: this.sequence, child: undefined });
    this.onBusyChange(uri, false);
  }

  clear(uri) {
    this.cancel(uri);
    this.collection.delete(uri);
  }

  dispose() {
    for (const current of this.jobs.values()) {
      if (current.child) {
        current.child.kill();
      }
    }
    this.jobs.clear();
  }

  async lint(document, interactive = false) {
    if (!isBendDocument(document) || isGeneratedFile(document)) {
      return { status: 'skipped' };
    }

    const key = document.uri.toString();
    const previous = this.jobs.get(key);
    if (previous && previous.child) {
      previous.child.kill();
    }

    const id = ++this.sequence;
    this.jobs.set(key, { id, child: undefined });
    this.onBusyChange(document.uri, true);

    const directory = path.dirname(document.uri.fsPath);
    const suffix = `${process.pid}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    const sourceName = `${TEMP_PREFIX}Source_${suffix}.bend`;
    const wrapperName = `${TEMP_PREFIX}Check_${suffix}.bend`;
    const sourcePath = path.join(directory, sourceName);
    const wrapperPath = path.join(directory, wrapperName);
    const temporaryFiles = [sourcePath, wrapperPath];
    const config = configuration(document.uri);
    const executable = expandHome(config.get('executablePath', 'bend'));
    const timeout = config.get('lint.timeout', 20000);

    let result;
    let companionName;
    try {
      const documentSource = document.getText();
      await fs.writeFile(sourcePath, documentSource, { encoding: 'utf8', flag: 'wx' });

      let checkTargetName = sourceName;
      const useProofCompanion = config.get('lint.lawsThroughProof', true);
      if (
        useProofCompanion &&
        path.basename(document.uri.fsPath) === 'LAWS.bend' &&
        containsLaw(documentSource)
      ) {
        const proofPath = path.join(directory, 'PROOF.bend');
        try {
          const proofSource = await sourceForFile(proofPath);
          const rewritten = rewriteCompanionImport(
            proofSource,
            proofPath,
            document.uri.fsPath,
            sourceName
          );
          if (rewritten.replaced) {
            companionName = `${TEMP_PREFIX}Proof_${suffix}.bend`;
            const companionPath = path.join(directory, companionName);
            temporaryFiles.push(companionPath);
            await fs.writeFile(
              companionPath,
              rewritten.source,
              { encoding: 'utf8', flag: 'wx' }
            );
            checkTargetName = companionName;
          }
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      await fs.writeFile(
        wrapperPath,
        `import ./${checkTargetName} as Bend2VscodeTarget\n`,
        { encoding: 'utf8', flag: 'wx' }
      );

      const processRun = runProcess(executable, [wrapperPath], {
        cwd: directory,
        timeout,
        env: { ...process.env, BEND_NO_TELEMETRY: '1' },
        onSpawn: (child) => {
          const current = this.jobs.get(key);
          if (current && current.id === id) {
            current.child = child;
          } else {
            child.kill();
          }
        }
      });
      result = await processRun.result;
    } catch (error) {
      result = { code: null, error, output: '' };
    } finally {
      try {
        await removeFiles(temporaryFiles);
      } catch (error) {
        this.output.appendLine(`Could not remove Bend 2 check file: ${error.message}`);
      }
    }

    const current = this.jobs.get(key);
    if (!current || current.id !== id) {
      return { status: 'cancelled' };
    }
    this.jobs.delete(key);
    this.onBusyChange(document.uri, false);

    if (result.error) {
      const message = result.error.code === 'ENOENT'
        ? `Bend 2 executable not found: ${executable}. Configure bend2.executablePath.`
        : `Could not run Bend 2: ${result.error.message}`;
      const diagnostic = new vscode.Diagnostic(
        diagnosticRange(document, 0),
        message,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'Bend 2';
      diagnostic.code = 'compiler-unavailable';
      this.collection.set(document.uri, [diagnostic]);
      if (interactive) {
        this.output.appendLine(message);
      }
      return { status: 'unavailable', message };
    }

    if (result.timedOut) {
      const message = `Bend 2 check exceeded ${timeout} ms and was stopped.`;
      const diagnostic = new vscode.Diagnostic(
        diagnosticRange(document, 0),
        message,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'Bend 2';
      diagnostic.code = 'compiler-timeout';
      this.collection.set(document.uri, [diagnostic]);
      return { status: 'timeout', message };
    }

    if (result.outputTooLarge) {
      const message = 'Bend 2 compiler output exceeded the 1 MiB safety limit.';
      const diagnostic = new vscode.Diagnostic(
        diagnosticRange(document, 0),
        message,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'Bend 2';
      diagnostic.code = 'compiler-output-limit';
      this.collection.set(document.uri, [diagnostic]);
      return { status: 'failed', message };
    }

    if (result.code === 0) {
      this.collection.set(document.uri, []);
      return { status: 'passed' };
    }

    const output = replaceGeneratedNames(
      cleanCompilerOutput(result.output),
      generatedNameReplacements(sourceName, path.basename(document.uri.fsPath), companionName)
    );
    this.collection.set(document.uri, compilerDiagnostics(document, output, {
      companionUsed: Boolean(companionName)
    }));
    this.output.appendLine(`\n[${new Date().toISOString()}] ${document.uri.fsPath}`);
    this.output.appendLine(output || `Bend 2 exited with code ${result.code}.`);
    return { status: 'failed', message: fallbackMessage(output) };
  }
}

function completionKind(kind) {
  switch (kind) {
    case 'def': return vscode.CompletionItemKind.Function;
    case 'type': return vscode.CompletionItemKind.Struct;
    case 'law': return vscode.CompletionItemKind.Interface;
    case 'constructor': return vscode.CompletionItemKind.Constructor;
    default: return vscode.CompletionItemKind.Keyword;
  }
}

function symbolKind(kind) {
  switch (kind) {
    case 'def': return vscode.SymbolKind.Function;
    case 'type': return vscode.SymbolKind.Struct;
    case 'law': return vscode.SymbolKind.Interface;
    case 'constructor': return vscode.SymbolKind.Constructor;
    default: return vscode.SymbolKind.Variable;
  }
}

async function importedDocument(document, alias) {
  const parsed = parseDocument(document.getText());
  const imported = parsed.imports.find((item) => item.alias === alias);
  if (!imported) {
    return undefined;
  }
  const resolved = resolveLocalImport(document.uri.fsPath, imported.path);
  if (!resolved) {
    return undefined;
  }
  try {
    return await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
  } catch (_error) {
    return undefined;
  }
}

function completionFromDeclaration(declaration, moduleName) {
  const item = new vscode.CompletionItem(declaration.name, completionKind(declaration.kind));
  item.detail = `${declaration.signature}${moduleName ? ` — ${moduleName}` : ''}`;
  if (declaration.documentation) {
    item.documentation = new vscode.MarkdownString(declaration.documentation);
  }
  return item;
}

const completionProvider = {
  async provideCompletionItems(document, position) {
    const prefix = document.lineAt(position.line).text.slice(0, position.character);
    const qualified = prefix.match(/([A-Za-z_][A-Za-z0-9_]*)\.$/);
    if (qualified) {
      const target = await importedDocument(document, qualified[1]);
      if (target) {
        return parseDocument(target.getText()).declarations.map((declaration) =>
          completionFromDeclaration(declaration, qualified[1])
        );
      }
      const members = BASE_MEMBERS.get(qualified[1]);
      if (!members) {
        return [];
      }
      return members.map((name) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
        item.detail = `Bend 2 Base member ${qualified[1]}.${name}`;
        item.documentation = new vscode.MarkdownString(
          `Run **Bend 2: Show Base Documentation** on \`${qualified[1]}.${name}\` for its current compiler signature.`
        );
        return item;
      });
    }

    const seen = new Set();
    const completions = [];
    for (const declaration of parseDocument(document.getText()).declarations) {
      if (!seen.has(declaration.name)) {
        seen.add(declaration.name);
        completions.push(completionFromDeclaration(declaration));
      }
    }
    for (const keyword of KEYWORD_COMPLETIONS) {
      if (seen.has(keyword)) {
        continue;
      }
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
      const help = LANGUAGE_HELP.get(keyword);
      if (help) {
        item.detail = help[0];
        item.documentation = new vscode.MarkdownString(help[1]);
      }
      completions.push(item);
    }
    return completions;
  }
};

function qualifiedWord(document, position) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.]*/);
  return range ? { range, text: document.getText(range) } : undefined;
}

async function findDeclaration(document, word) {
  const local = declarationAt(parseDocument(document.getText()), word);
  if (local) {
    return { declaration: local, document };
  }

  const dot = word.indexOf('.');
  if (dot > 0) {
    const alias = word.slice(0, dot);
    const name = word.slice(dot + 1);
    const target = await importedDocument(document, alias);
    if (target) {
      const declaration = declarationAt(parseDocument(target.getText()), name);
      if (declaration) {
        return { declaration, document: target };
      }
    }
  }
  return undefined;
}

const hoverProvider = {
  async provideHover(document, position) {
    const word = qualifiedWord(document, position);
    if (!word) {
      return undefined;
    }

    const found = await findDeclaration(document, word.text);
    if (found) {
      const markdown = new vscode.MarkdownString();
      markdown.appendCodeblock(found.declaration.signature, 'bend');
      if (found.declaration.documentation) {
        markdown.appendMarkdown(`\n${found.declaration.documentation}`);
      }
      return new vscode.Hover(markdown, word.range);
    }

    const key = word.text.startsWith('Base.') ? word.text.slice(5) : word.text;
    const help = LANGUAGE_HELP.get(key);
    if (help) {
      const markdown = new vscode.MarkdownString(`**${help[0]}**\n\n${help[1]}`);
      return new vscode.Hover(markdown, word.range);
    }

    const memberParts = key.split('.');
    const members = BASE_MEMBERS.get(memberParts[0]);
    if (memberParts.length === 2 && members && members.includes(memberParts[1])) {
      const markdown = new vscode.MarkdownString(
        `**Bend 2 Base member \`${key}\`**\n\nRun **Bend 2: Show Base Documentation** for its current compiler signature and related definitions.`
      );
      return new vscode.Hover(markdown, word.range);
    }
    return undefined;
  }
};

const definitionProvider = {
  async provideDefinition(document, position) {
    const word = qualifiedWord(document, position);
    if (!word) {
      return undefined;
    }
    const found = await findDeclaration(document, word.text);
    if (!found) {
      return undefined;
    }
    const start = new vscode.Position(found.declaration.line, found.declaration.character);
    const end = start.translate(0, found.declaration.name.length);
    return new vscode.Location(found.document.uri, new vscode.Range(start, end));
  }
};

const documentSymbolProvider = {
  provideDocumentSymbols(document) {
    return parseDocument(document.getText()).declarations.map((declaration) => {
      const line = document.lineAt(declaration.line);
      const range = new vscode.Range(declaration.line, 0, declaration.line, line.text.length);
      const selection = new vscode.Range(
        declaration.line,
        declaration.character,
        declaration.line,
        declaration.character + declaration.name.length
      );
      return new vscode.DocumentSymbol(
        declaration.name,
        declaration.signature,
        symbolKind(declaration.kind),
        range,
        selection
      );
    });
  }
};

async function checkCurrentFile(lintManager) {
  const document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (!isBendDocument(document)) {
    vscode.window.showInformationMessage('Open a Bend 2 (.bend) file to run the checker.');
    return;
  }
  const result = await lintManager.lint(document, true);
  if (result.status === 'passed') {
    vscode.window.showInformationMessage('Bend 2 check passed.');
  } else if (result.status === 'failed') {
    vscode.window.showErrorMessage('Bend 2 check failed. See Problems and the Bend 2 output channel.');
  } else if (result.message) {
    vscode.window.showWarningMessage(result.message);
  }
}

async function runCurrentFile() {
  let document = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (!isBendDocument(document)) {
    vscode.window.showInformationMessage('Open a Bend 2 (.bend) file to run it.');
    return;
  }
  if (document.isDirty) {
    const saved = await document.save();
    if (!saved) {
      return;
    }
    document = vscode.window.activeTextEditor.document;
  }

  const executable = expandHome(configuration(document.uri).get('executablePath', 'bend'));
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const execution = new vscode.ProcessExecution(
    executable,
    [document.uri.fsPath],
    { cwd: path.dirname(document.uri.fsPath) }
  );
  const task = new vscode.Task(
    { type: 'bend2', command: 'run', file: document.uri.fsPath },
    folder || vscode.TaskScope.Workspace,
    `Run ${path.basename(document.uri.fsPath)}`,
    'Bend 2',
    execution
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true
  };
  await vscode.tasks.executeTask(task);
}

async function showBaseDocumentation(output) {
  const editor = vscode.window.activeTextEditor;
  let query = '';
  let uri;
  if (editor) {
    uri = editor.document.uri;
    query = editor.document.getText(editor.selection).trim();
    if (!query) {
      const word = qualifiedWord(editor.document, editor.selection.active);
      query = word ? word.text : '';
    }
  }
  if (query.startsWith('Base.')) {
    query = query.slice(5);
  }
  if (!query || query.includes('.bend')) {
    const entered = await vscode.window.showInputBox({
      title: 'Bend 2 Base documentation',
      prompt: 'Type a Base name, for example Map, Nat.add, or IO.print',
      value: query,
      placeHolder: 'Map'
    });
    if (entered === undefined) {
      return;
    }
    query = entered.trim();
  }

  const executable = expandHome(configuration(uri).get('executablePath', 'bend'));
  const args = ['base'];
  if (query && query !== 'Base') {
    args.push(query);
  }
  output.clear();
  output.show(true);
  output.appendLine(`> ${executable} ${args.join(' ')}`);
  const processRun = runProcess(executable, args, {
    timeout: 20000,
    maxOutput: 4 * MAX_OUTPUT,
    env: { ...process.env, BEND_NO_TELEMETRY: '1' }
  });
  const result = await processRun.result;
  if (result.error) {
    output.appendLine(`Could not run Bend 2: ${result.error.message}`);
    return;
  }
  output.append(result.output || '(No documentation returned.)\n');
}

function activate(context) {
  const selector = { language: 'bend2', scheme: 'file' };
  const diagnostics = vscode.languages.createDiagnosticCollection('bend2');
  const output = vscode.window.createOutputChannel('Bend 2');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const busy = new Set();
  const timers = new Map();

  const updateStatus = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'bend2') {
      status.hide();
      return;
    }
    const key = editor.document.uri.toString();
    status.text = busy.has(key) ? '$(sync~spin) Bend 2' : '$(check) Bend 2';
    status.tooltip = busy.has(key) ? 'Checking with the Bend 2 compiler…' : 'Check current Bend 2 file';
    status.command = 'bend2.checkFile';
    status.show();
  };

  const lintManager = new LintManager(diagnostics, output, (uri, isBusy) => {
    const key = uri.toString();
    if (isBusy) {
      busy.add(key);
    } else {
      busy.delete(key);
    }
    updateStatus();
  });
  activeLintManager = lintManager;

  const clearTimer = (uri) => {
    const key = uri.toString();
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
  };

  const schedule = (document) => {
    if (!isBendDocument(document) || isGeneratedFile(document)) {
      return;
    }
    clearTimer(document.uri);
    lintManager.cancel(document.uri);
    const delay = configuration(document.uri).get('lint.delay', 600);
    const key = document.uri.toString();
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      lintManager.lint(document);
    }, delay));
  };

  const checkOnOpen = (document) => {
    if (!isBendDocument(document) || isGeneratedFile(document)) {
      return;
    }
    const config = configuration(document.uri);
    if (config.get('lint.run', 'onSave') !== 'off' && config.get('lint.onOpen', true)) {
      lintManager.lint(document);
    }
  };

  context.subscriptions.push(
    diagnostics,
    output,
    status,
    { dispose: () => lintManager.dispose() },
    vscode.commands.registerCommand('bend2.checkFile', () => checkCurrentFile(lintManager)),
    vscode.commands.registerCommand('bend2.runFile', runCurrentFile),
    vscode.commands.registerCommand('bend2.showBaseDocumentation', () => showBaseDocumentation(output)),
    vscode.languages.registerCompletionItemProvider(selector, completionProvider, '.'),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerDocumentSymbolProvider(selector, documentSymbolProvider),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidOpenTextDocument(checkOnOpen),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (configuration(event.document.uri).get('lint.run', 'onSave') === 'onType') {
        schedule(event.document);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isBendDocument(document)) {
        return;
      }
      clearTimer(document.uri);
      const mode = configuration(document.uri).get('lint.run', 'onSave');
      if (mode === 'onSave' || mode === 'onType') {
        lintManager.lint(document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimer(document.uri);
      lintManager.cancel(document.uri);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        clearTimer(uri);
        lintManager.clear(uri);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('bend2')) {
        return;
      }
      for (const document of vscode.workspace.textDocuments) {
        if (!isBendDocument(document)) {
          continue;
        }
        clearTimer(document.uri);
        if (configuration(document.uri).get('lint.run', 'onSave') === 'off') {
          lintManager.clear(document.uri);
        } else {
          lintManager.lint(document);
        }
      }
    })
  );

  updateStatus();
  for (const document of vscode.workspace.textDocuments) {
    checkOnOpen(document);
  }
}

function deactivate() {
  if (activeLintManager) {
    activeLintManager.dispose();
    activeLintManager = undefined;
  }
}

module.exports = { activate, deactivate };
