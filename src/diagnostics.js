'use strict';

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

module.exports = {
  cleanCompilerOutput,
  fallbackMessage,
  parseCompilerOutput,
  parseTodoCount
};
