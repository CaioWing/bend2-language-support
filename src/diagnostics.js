'use strict';

const { Diagnostic, DiagnosticSeverity, Range } = require('vscode-languageserver/node');
const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { parseDocument } = require('./symbols');

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const INSTALLER_NOTICE = /^(?:Bend's installer changed\.(?: Update with: curl -fsSL https:\/\/bend-lang\.com\/install\.sh \| sh)?|Update with: curl -fsSL https:\/\/bend-lang\.com\/install\.sh \| sh)[ \t]*$/;

function cleanCompilerOutput(output) {
  return String(output || '')
    .replace(ANSI_ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !INSTALLER_NOTICE.test(line))
    .join('\n')
    .trim();
}

function parseErrorBlock(block) {
  const sourceLine = block.match(/^\s*(\d+)>\|\s?(.*)$/m);
  const location = block.match(/^Location:[ \t]*(.*)$/m);
  const detailsEnd = block.search(/^Location:/m);
  const details = (detailsEnd >= 0 ? block.slice(0, detailsEnd) : block)
    .replace(/^Error:\s*/i, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();

  if (!details && !sourceLine) {
    return undefined;
  }

  const locationName = location && location[1] ? location[1].trim() : '';
  return {
    line: sourceLine ? Math.max(0, Number(sourceLine[1]) - 1) : 0,
    sourceText: sourceLine ? sourceLine[2] : '',
    location: locationName,
    message: `${details || 'Bend 2 compiler error'}${locationName ? `\nLocation: ${locationName}` : ''}`
  };
}

function parseTodoCount(output) {
  const cleaned = cleanCompilerOutput(output);
  const match = cleaned.match(/^Error:[ \t]*(\d+)[ \t]+TODOs?[ \t]+found\./m);
  return match ? Number(match[1]) : undefined;
}

function parseCompilerOutput(output) {
  const cleaned = cleanCompilerOutput(output);
  if (!cleaned) {
    return [];
  }

  const starts = [];
  const marker = /^Error:/gm;
  let match;
  while ((match = marker.exec(cleaned)) !== null) {
    starts.push(match.index);
  }

  if (starts.length === 0) {
    return [];
  }

  return starts
    .map((start, index) => cleaned.slice(start, starts[index + 1] ?? cleaned.length).trim())
    .map(parseErrorBlock)
    .filter(Boolean);
}

function fallbackMessage(output, limit = 4000) {
  const cleaned = cleanCompilerOutput(output);
  if (!cleaned) {
    return 'The Bend 2 compiler failed without producing an error message.';
  }
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function diagnosticRange(document, requestedLine) {
  if (document.getText().split("\n").length === 0) {
    return Range.create(0, 0, 0, 0);
  }
  const lineNumber = Math.min(Math.max(requestedLine, 0), document.getText().split("\n").length - 1);
  const text = document.getText().split("\n")[lineNumber].replace(/\r$/, "");
  const line = { text, firstNonWhitespaceCharacterIndex: text.search(/\S|$/) };
  const start = line.firstNonWhitespaceCharacterIndex;
  return Range.create(lineNumber, start, lineNumber, line.text.length);
}

function compilerDiagnostics(document, output, context = {}) {
  const todoCount = parseTodoCount(output);
  if (todoCount !== undefined) {
    const laws = parseDocument(document.getText()).declarations.filter((item) => item.kind === 'law');
    const noCompanion = path.basename(fileURLToPath(document.uri)) === 'LAWS.bend' && !context.companionUsed;
    if (noCompanion && laws.length === todoCount) {
      return laws.map((law) => {
        const diagnostic = Diagnostic.create(
          diagnosticRange(document, law.line),
          `Open law '${law.name}' was checked without its proof companion. ` +
            'The linter did not find a sibling PROOF.bend importing ./LAWS.bend, or ' +
            'bend2.lint.lawsThroughProof is disabled.',
          DiagnosticSeverity.Error
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
    const diagnostic = Diagnostic.create(
      diagnosticRange(document, 0),
      `Bend found ${todoCount} unresolved proof ${noun}, but did not report exact source locations. ${route}`,
      DiagnosticSeverity.Error
    );
    diagnostic.source = 'Bend 2';
    diagnostic.code = 'unresolved-proof-obligations';
    return [diagnostic];
  }

  const parsed = parseCompilerOutput(output);
  if (parsed.length === 0) {
    const diagnostic = Diagnostic.create(
      diagnosticRange(document, 0),
      fallbackMessage(output),
      DiagnosticSeverity.Error
    );
    diagnostic.source = 'Bend 2';
    diagnostic.code = 'compiler-error';
    return [diagnostic];
  }

  return parsed.map((item) => {
    let line = item.line;
    let message = item.message;
    const sourceText = item.sourceText.trim();
    const targetText = line < document.getText().split("\n").length ? document.getText().split("\n")[line].trim() : '';
    if (sourceText && sourceText !== targetText) {
      line = 0;
      message += `\nCompiler excerpt at line ${item.line + 1}: ${sourceText}`;
    }
    const diagnostic = Diagnostic.create(
      diagnosticRange(document, line),
      message,
      DiagnosticSeverity.Error
    );
    diagnostic.source = 'Bend 2';
    diagnostic.code = 'compiler-error';
    return diagnostic;
  });
}


module.exports = {
  compilerDiagnostics,
  diagnosticRange,
  cleanCompilerOutput,
  fallbackMessage,
  parseCompilerOutput,
  parseTodoCount
};
