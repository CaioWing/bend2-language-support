'use strict';
const { codeOnly } = require('./lexical');
const { parseDocument } = require('./symbols');

const KEYWORDS = [
  'def', 'type', 'law', 'match', 'case', 'do', 'return', 'for', 'exs', 'where',
  'import', 'as', 'is', 'Type', 'Data', 'Kind', 'Quant', 'Nat', 'U32', 'F32',
  'String', 'Char', 'Bool', 'Unit', 'List', 'Array', 'Map', 'Set', 'Maybe',
  'Result', 'Equal', 'IO', 'True', 'False', 'None', 'Some', 'Fail', 'Done'
];

const RESERVED_BINDINGS = new Set([
  ...KEYWORDS, 'case', 'match', 'return', 'import', 'as', 'is', 'where'
]);

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ('(<[{'.includes(char)) depth += 1;
    if (')>]}'.includes(char) && !(char === '>' && value[index - 1] === '-')) depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parameterList(signature) {
  const open = signature.indexOf('(');
  if (open < 0) return [];
  let depth = 0;
  for (let index = open; index < signature.length; index += 1) {
    if (signature[index] === '(') depth += 1;
    if (signature[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return splitTopLevel(signature.slice(open + 1, index));
      }
    }
  }
  return [];
}

function bindingFromParameter(parameter, line) {
  const match = parameter.match(/^\s*[+\-~]?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.+))?$/);
  if (!match || RESERVED_BINDINGS.has(match[1])) return undefined;
  return {
    name: match[1],
    type: match[2]?.trim(),
    detail: match[2] ? `parameter: ${match[2]}` : 'parameter',
    line,
    character: Math.max(0, parameter.indexOf(match[1]))
  };
}

function visibleBindings(text, position) {
  const parsed = parseDocument(text);
  const lines = codeOnly(text).replace(/\r/g, '').split('\n');
  const declaration = parsed.declarations.findLast((item) => item.kind !== 'constructor' && item.line <= position.line);
  if (!declaration || !['def', 'law', 'type'].includes(declaration.kind)) return [];
  const declarationLine = declaration.line;
  const scopes = [new Map()];
  const stack = [{ indent: -1, bindings: scopes[0] }];
  const put = (name, line, character, detail, type) => {
    if (name !== '_' && !RESERVED_BINDINGS.has(name)) stack.at(-1).bindings.set(name, { name, line, character, detail, type });
  };
  const headerEnd = declaration.headerEndLine ?? declarationLine;
  const header = lines.slice(declarationLine, headerEnd + 1).join('\n');
  let search = header.indexOf('(') + 1;
  const parameters = declaration.kind === 'type'
    ? (!header.includes('<') ? [] : splitTopLevel(header.slice(header.indexOf('<') + 1, header.lastIndexOf('>'))))
    : parameterList(declaration.signature);
  for (const parameter of parameters) {
    const binding = bindingFromParameter(parameter, declarationLine);
    if (!binding) continue;
    const offset = header.indexOf(binding.name, search);
    search = offset + binding.name.length;
    const before = header.slice(0, offset).split('\n');
    put(binding.name, declarationLine + before.length - 1, before.at(-1).length, binding.detail, binding.type);
  }
  for (let line = headerEnd + 1; line <= Math.min(position.line, lines.length - 1); line += 1) {
    const full = lines[line];
    let value = line === position.line ? full.slice(0, position.character) : full;
    const indent = full.search(/\S/);
    if (indent < 0) continue;
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    if (indent === 0) return [];
    const quantifier = value.match(/^\s*(?:for|exs)\s+[+~-]?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.+))?/);
    if (quantifier) put(quantifier[1], line, value.indexOf(quantifier[1], value.indexOf('for') + 3), 'binder', quantifier[2]);
    const pattern = value.match(/^\s*case\s+(.+):\s*$/);
    if (pattern) stack.push({ indent, bindings: new Map() });
    const assignment = value.match(/^\s*(.+?)\s*(?:<-(?![=])|=(?![=>]))\s*.+/);
    const left = pattern?.[1] || (line < position.line ? assignment?.[1] : undefined);
    if (left) {
      const annotated = left.match(/^\s*[+~-]?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
      const offset = value.indexOf(left);
      if (annotated) put(annotated[1], line, offset + left.indexOf(annotated[1]), `local binding: ${annotated[2]}`, annotated[2]);
      else for (const match of left.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
        if (match[0].includes('.') || /^[A-Z]/.test(match[0]) || /[0-9]/.test(left[match.index - 1] || '')) continue;
        put(match[0], line, offset + match.index, pattern ? 'pattern binding' : 'local binding');
      }
    }
    // Inline lambdas end at their containing expression. Do not leak them to
    // following statements; multiline lambdas have an indentation scope.
    for (const match of value.matchAll(/([+~-]?)([a-z_][A-Za-z0-9_]*)\s*=>/g)) {
      const body = value.slice(match.index + match[0].length);
      if (!body.trim()) stack.push({ indent, bindings: new Map() });
      else if (line !== position.line || /[),]/.test(body)) continue;
      put(match[2], line, match.index + match[1].length, 'lambda parameter');
    }
  }
  return [...new Map(stack.flatMap((scope) => [...scope.bindings])).values()];
}

function completionContext(text, position) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const prefix = (lines[position.line] || '').slice(0, position.character);
  const qualified = prefix.match(/([A-Za-z_][A-Za-z0-9_.]*)\.([A-Za-z0-9_]*)$/);
  return {
    prefix,
    qualifier: qualified ? qualified[1] : undefined,
    memberPrefix: qualified ? qualified[2] : undefined,
    inCase: /^\s*case\s+[^:]*$/.test(prefix),
    bindings: visibleBindings(text, position)
  };
}

function callContext(text, position) {
  const lines = codeOnly(text).split('\n');
  const before = lines.slice(0, position.line).concat((lines[position.line] || '').slice(0, position.character)).join('\n');
  const stack = [];
  for (let index = 0; index < before.length; index += 1) {
    const char = before[index];
    if ('([{'.includes(char) || (char === '<' && /[A-Za-z0-9_>]/.test(before[index - 1] || '') && !/[=>]/.test(before[index + 1] || ''))) {
      const name = char === '(' ? before.slice(0, index).match(/([A-Za-z_][A-Za-z0-9_.]*)!?\s*$/)?.[1] : undefined;
      stack.push({ char, name, activeParameter: 0 });
    } else if (')]}'.includes(char) || (char === '>' && before[index - 1] !== '-' && stack.at(-1)?.char === '<')) stack.pop();
    else if (char === ',' && stack.length) stack.at(-1).activeParameter += 1;
  }
  const call = stack.findLast((item) => item.name);
  return call ? { name: call.name, activeParameter: call.activeParameter } : undefined;
}

module.exports = {
  KEYWORDS,
  callContext,
  completionContext,
  parameterList,
  splitTopLevel,
  visibleBindings
};
