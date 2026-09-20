'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  CompletionItemKind,
  createConnection,
  DocumentSymbol,
  InsertTextFormat,
  Location,
  MarkupKind,
  ParameterInformation,
  ProposedFeatures,
  Range,
  SignatureInformation,
  SymbolKind,
  TextDocumentSyncKind
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { TextDocuments } = require('vscode-languageserver/node');
const { parseDocument, declarationAt, resolveLocalImport } = require('./symbols');
const {
  BASE_MEMBERS,
  KEYWORDS,
  callContext,
  completionContext,
  parameterList,
  visibleBindings
} = require('./language-service');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const execFileAsync = promisify(execFile);
const baseCache = new Map();
let settings = { executablePath: 'bend' };

const HELP = new Map([
  ['def', 'Declares a typed function. Bend performs little inference, so explicit annotations are recommended.'],
  ['type', 'Declares a datatype and its kind (`Data`, `Type`, or `Kind(q)`).'],
  ['law', 'Declares a proposition implemented by a `def` with the same qualified name.'],
  ['match', 'Pattern-matches a parameter or pattern-bound value. Bend has no `if`; match on `True{}` and `False{}`.'],
  ['do', 'Sequences operations of a monad such as `IO`, `Maybe`, or `Result`.'],
  ['Data', '`Data` is `Kind(&2)`; values may be reused when marked with `+`.'],
  ['Type', '`Type` is `Kind(&1)`; values are affine.'],
  ['Nat', 'Machine-word natural number. Literals have an `n` suffix, such as `42n`.'],
  ['IO', 'Type of effectful computations, usually sequenced in a `do IO<T>:` block.'],
  ['?TODO', 'Leaves a proof obligation open. The compiler rejects reachable TODOs.']
]);

const SNIPPETS = [
  { label: 'def', detail: 'Function definition', insertText: 'def ${1:name}(${2:x}: ${3:U32}) -> ${4:U32}:\n  ${0:x}' },
  { label: 'match', detail: 'Pattern match', insertText: 'match ${1:value}:\n  case ${2:Constructor}{${3:field}}:\n    ${0:field}' },
  { label: 'do IO', detail: 'IO do block', insertText: 'do IO<${1:Unit}>:\n  ${2:value} : ${3:U32} <- ${4:effect}\n  return ${0:value}' },
  { label: 'law', detail: 'Law declaration', insertText: 'law ${1:name}:\n  for ${2:x}: ${3:Nat}\n  ${0:{${2:x} == ${2:x} : ${3:Nat}}}' },
  { label: 'type Data', detail: 'Reusable datatype', insertText: 'type ${1:Name} is Data:\n  ${2:Constructor}{${3:value}: ${4:U32}}' }
];

function declarationKind(kind) {
  switch (kind) {
    case 'def': return CompletionItemKind.Function;
    case 'type': return CompletionItemKind.Struct;
    case 'law': return CompletionItemKind.Interface;
    case 'constructor': return CompletionItemKind.Constructor;
    default: return CompletionItemKind.Text;
  }
}

function lspSymbolKind(kind) {
  switch (kind) {
    case 'def': return SymbolKind.Function;
    case 'type': return SymbolKind.Struct;
    case 'law': return SymbolKind.Interface;
    case 'constructor': return SymbolKind.Constructor;
    default: return SymbolKind.Variable;
  }
}

function uriPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch (_error) {
    return undefined;
  }
}

async function documentSource(uri) {
  const open = documents.get(uri);
  if (open) return open.getText();
  const file = uriPath(uri);
  return file ? fs.readFile(file, 'utf8') : undefined;
}

async function importedSource(document, alias) {
  const parsed = parseDocument(document.getText());
  const imported = parsed.imports.find((item) => item.alias === alias);
  if (!imported) return undefined;
  const currentFile = uriPath(document.uri);
  const file = resolveLocalImport(currentFile, imported.path);
  if (!file) return undefined;
  const uri = pathToFileURL(file).href;
  try {
    return { file, uri, text: await documentSource(uri), imported };
  } catch (_error) {
    return undefined;
  }
}

function snippetName(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '') || 'value';
}

function callSnippet(declaration, insertedName, fixedArgument) {
  if (declaration.kind !== 'def') return insertedName;
  const parameters = parameterList(declaration.signature);
  const argumentsList = [];
  let placeholder = 1;
  for (let index = 0; index < parameters.length; index += 1) {
    if (fixedArgument?.index === index) {
      argumentsList.push(fixedArgument.value);
      continue;
    }
    const name = parameters[index].match(/^[+\-~]?([A-Za-z_][A-Za-z0-9_]*)/)?.[1] || `arg${index + 1}`;
    argumentsList.push(`\${${placeholder}:${snippetName(name)}}`);
    placeholder += 1;
  }
  return `${insertedName}(${argumentsList.join(', ')})`;
}

function declarationCompletion(declaration, options = {}) {
  const label = options.label || declaration.name;
  const insertedName = options.insertedName || label;
  const item = {
    label,
    kind: declarationKind(declaration.kind),
    detail: `${declaration.signature}${options.source ? ` — ${options.source}` : ''}`,
    documentation: declaration.documentation || undefined
  };
  if (declaration.kind === 'def') {
    item.insertText = callSnippet(declaration, insertedName, options.fixedArgument);
    item.insertTextFormat = InsertTextFormat.Snippet;
    item.command = { title: 'Trigger parameter hints', command: 'editor.action.triggerParameterHints' };
  }
  if (options.textEditRange) {
    item.textEdit = { range: options.textEditRange, newText: item.insertText || insertedName };
    delete item.insertText;
  }
  return item;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

async function baseDeclarations(owner) {
  const executable = expandHome(settings.executablePath || 'bend');
  const key = `${executable}\0${owner}`;
  if (!baseCache.has(key)) {
    baseCache.set(key, (async () => {
      try {
        const { stdout } = await execFileAsync(executable, ['base', owner], {
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, BEND_NO_TELEMETRY: '1' }
        });
        return namespaceMembers(parseDocument(stdout).declarations, owner);
      } catch (_error) {
        return (BASE_MEMBERS.get(owner) || []).map((member) => ({
          kind: 'base-member',
          name: `${owner}.${member}`,
          signature: `def ${owner}.${member}(…)`,
          documentation: 'Compiler signature unavailable.',
          line: 0,
          character: 0
        }));
      }
    })());
  }
  return baseCache.get(key);
}

function namespaceMembers(declarations, owner) {
  const prefix = `${owner}.`;
  const members = new Map();
  for (const item of declarations) {
    if (!item.name.startsWith(prefix) || item.name.slice(prefix.length).includes('.')) continue;
    const previous = members.get(item.name);
    if (!previous || (previous.kind === 'law' && item.kind === 'def')) members.set(item.name, item);
  }
  return [...members.values()];
}

function bindingOwner(type) {
  return type?.trim().replace(/^\+/, '').match(/^([A-Za-z_][A-Za-z0-9_.]*)/)?.[1];
}

function receiverParameterIndex(declaration, owner) {
  if (declaration.kind !== 'def') return -1;
  return parameterList(declaration.signature).findIndex((parameter) => {
    const separator = parameter.indexOf(':');
    return separator >= 0 && bindingOwner(parameter.slice(separator + 1)) === owner;
  });
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.label}\0${item.detail || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wordAt(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_.?]/.test(text[start - 1])) start -= 1;
  while (end < text.length && /[A-Za-z0-9_.]/.test(text[end])) end += 1;
  if (start === end) return undefined;
  return { text: text.slice(start, end), range: Range.create(document.positionAt(start), document.positionAt(end)) };
}

async function findDeclaration(document, name) {
  const lookupName = name.startsWith('Base.') ? name.slice(5) : name;
  const local = declarationAt(parseDocument(document.getText()), lookupName);
  if (local) return { declaration: local, uri: document.uri, text: document.getText() };
  const dot = lookupName.indexOf('.');
  if (dot <= 0) return undefined;
  const owner = lookupName.slice(0, dot);
  const memberName = lookupName.slice(dot + 1);
  const imported = await importedSource(document, owner);
  if (imported) {
    const declaration = declarationAt(parseDocument(imported.text), memberName);
    if (declaration) return { declaration, uri: imported.uri, text: imported.text };
  }
  const declaration = (await baseDeclarations(owner)).find((item) => item.name === lookupName);
  return declaration ? { declaration, external: true } : undefined;
}

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
    hoverProvider: true,
    definitionProvider: true,
    documentSymbolProvider: true,
    signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
    documentLinkProvider: { resolveProvider: false }
  },
  serverInfo: { name: 'Bend 2 Language Server', version: '0.2.3' }
}));

connection.onDidChangeConfiguration((change) => {
  settings = change.settings?.bend2 || change.settings || settings;
  baseCache.clear();
});

connection.onCompletion(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  const parsed = parseDocument(document.getText());
  const context = completionContext(document.getText(), position);

  if (context.qualifier) {
    const [importAlias, ...importNamespaceParts] = context.qualifier.split('.');
    const imported = await importedSource(document, importAlias);
    if (imported) {
      const importedDeclarations = parseDocument(imported.text).declarations;
      if (importNamespaceParts.length === 0) {
        return importedDeclarations.map((item) =>
          declarationCompletion(item, { source: context.qualifier })
        );
      }
      const importNamespace = importNamespaceParts.join('.');
      return namespaceMembers(importedDeclarations, importNamespace).map((item) => declarationCompletion(item, {
        label: item.name.slice(importNamespace.length + 1),
        insertedName: item.name.slice(importNamespace.length + 1),
        source: context.qualifier
      }));
    }

    const directMembers = namespaceMembers(parsed.declarations, context.qualifier);
    if (directMembers.length > 0) {
      return directMembers.map((item) => declarationCompletion(item, {
        label: item.name.slice(context.qualifier.length + 1),
        insertedName: item.name.slice(context.qualifier.length + 1),
        source: context.qualifier
      }));
    }

    const binding = context.bindings.find((item) => item.name === context.qualifier);
    const owner = bindingOwner(binding?.type);
    if (owner) {
      const customMembers = namespaceMembers(parsed.declarations, owner);
      const declarations = customMembers.length > 0 ? customMembers : await baseDeclarations(owner);
      const replacementStart = position.character - context.qualifier.length - context.memberPrefix.length - 1;
      const replacementRange = Range.create(position.line, replacementStart, position.line, position.character);
      return declarations.flatMap((item) => {
        const receiverIndex = receiverParameterIndex(item, owner);
        if (receiverIndex < 0) return [];
        const member = item.name.slice(owner.length + 1);
        return [declarationCompletion(item, {
          label: member,
          insertedName: `${owner}.${member}`,
          source: `${owner} function (rewrites ${context.qualifier}. to a valid Bend call)`,
          fixedArgument: { index: receiverIndex, value: context.qualifier },
          textEditRange: replacementRange
        })];
      });
    }

    const baseMembers = await baseDeclarations(context.qualifier);
    if (baseMembers.length > 0) {
      return baseMembers.map((item) => declarationCompletion(item, {
        label: item.name.slice(context.qualifier.length + 1),
        insertedName: item.name.slice(context.qualifier.length + 1),
        source: 'Bend Base'
      }));
    }
    return [];
  }

  const items = [];
  for (const binding of context.bindings) {
    items.push({ label: binding.name, kind: CompletionItemKind.Variable, detail: binding.detail });
  }
  for (const declaration of parsed.declarations) items.push(declarationCompletion(declaration));
  for (const imported of parsed.imports) {
    if (imported.alias && imported.alias !== 'Base') {
      items.push({
        label: imported.alias,
        kind: CompletionItemKind.Module,
        detail: `Module ${imported.path}`,
        insertText: `${imported.alias}.`,
        command: { title: 'Show module members', command: 'editor.action.triggerSuggest' }
      });
    }
  }
  for (const keyword of KEYWORDS) {
    items.push({ label: keyword, kind: CompletionItemKind.Keyword, detail: HELP.has(keyword) ? 'Bend 2 language keyword' : undefined, documentation: HELP.get(keyword) });
  }
  if (!context.inCase) {
    for (const snippet of SNIPPETS) {
      items.push({ ...snippet, kind: CompletionItemKind.Snippet, insertTextFormat: InsertTextFormat.Snippet });
    }
  } else {
    for (const declaration of parsed.declarations.filter((item) => item.kind === 'constructor')) {
      items.unshift(declarationCompletion(declaration));
    }
  }
  return deduplicate(items);
});

connection.onHover(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return undefined;
  const word = wordAt(document, position);
  if (!word) return undefined;
  const found = await findDeclaration(document, word.text);
  if (found) {
    const value = `\`\`\`bend\n${found.declaration.signature}\n\`\`\`${found.declaration.documentation ? `\n\n${found.declaration.documentation}` : ''}`;
    return { contents: { kind: MarkupKind.Markdown, value }, range: word.range };
  }
  const binding = visibleBindings(document.getText(), position).find((item) => item.name === word.text);
  if (binding) return { contents: { kind: MarkupKind.Markdown, value: `**${word.text}** — ${binding.detail}` }, range: word.range };
  const help = HELP.get(word.text.replace(/^Base\./, ''));
  if (help) return { contents: { kind: MarkupKind.Markdown, value: help }, range: word.range };
  const [owner, member, extra] = word.text.replace(/^Base\./, '').split('.');
  if (!extra && member && BASE_MEMBERS.get(owner)?.includes(member)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**Bend Base member \`${owner}.${member}\`**\n\nUse **Bend 2: Show Base Documentation** for its current signature.`
      },
      range: word.range
    };
  }
  return undefined;
});

connection.onDefinition(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return undefined;
  const word = wordAt(document, position);
  if (!word) return undefined;
  const found = await findDeclaration(document, word.text);
  if (found?.uri) {
    const start = { line: found.declaration.line, character: found.declaration.character };
    return Location.create(found.uri, Range.create(start, { line: start.line, character: start.character + found.declaration.name.length }));
  }
  const binding = visibleBindings(document.getText(), position).find((item) => item.name === word.text);
  if (!binding) return undefined;
  return Location.create(document.uri, Range.create(binding.line, binding.character, binding.line, binding.character + binding.name.length));
});

connection.onDocumentSymbol(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return [];
  return parseDocument(document.getText()).declarations.map((item) => {
    const lineEnd = document.getText(Range.create(item.line, 0, item.line + 1, 0)).replace(/\r?\n$/, '').length;
    return DocumentSymbol.create(
      item.name,
      item.signature,
      lspSymbolKind(item.kind),
      Range.create(item.line, 0, item.line, lineEnd),
      Range.create(item.line, item.character, item.line, item.character + item.name.length)
    );
  });
});

connection.onSignatureHelp(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return undefined;
  const call = callContext(document.getText(), position);
  if (!call) return undefined;
  const found = await findDeclaration(document, call.name);
  if (!found || found.declaration.kind !== 'def') return undefined;
  const parameters = parameterList(found.declaration.signature);
  const signature = SignatureInformation.create(
    found.declaration.signature,
    found.declaration.documentation || undefined,
    ...parameters.map((item) => ParameterInformation.create(item))
  );
  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: Math.min(call.activeParameter, Math.max(0, parameters.length - 1))
  };
});

connection.onDocumentLinks(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  const currentFile = uriPath(textDocument.uri);
  if (!document || !currentFile) return [];
  const lines = document.getText().replace(/\r\n?/g, '\n').split('\n');
  return parseDocument(document.getText()).imports.flatMap((item) => {
    const file = resolveLocalImport(currentFile, item.path);
    if (!file) return [];
    const character = lines[item.line].indexOf(item.path);
    return [{ range: Range.create(item.line, character, item.line, character + item.path.length), target: pathToFileURL(file).href }];
  });
});

documents.listen(connection);
connection.listen();
