'use strict';
// Preserve UTF-16 offsets while hiding comments and quoted literals.
function codeOnly(text) {
  let quote = '', comment = false, escaped = false;
  return String(text).split('').map((char) => {
    if (char === '\n' || char === '\r') { comment = false; quote = ''; escaped = false; return char; }
    if (comment) return ' ';
    if (quote) {
      if (!escaped && char === quote) quote = '';
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
      return ' ';
    }
    if (char === '#') { comment = true; return ' '; }
    if (char === '"' || char === "'") { quote = char; return ' '; }
    return char;
  }).join('');
}
function tokens(text) {
  const lines = codeOnly(text).split('\n');
  return lines.flatMap((line, number) => [...line.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)]
    .filter((m) => m.index === 0 || !/[A-Za-z0-9_]/.test(line[m.index - 1]))
    .map((m) => ({ name: m[0], line: number, character: m.index })));
}
module.exports = { codeOnly, tokens };
