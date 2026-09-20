'use strict';

const KEYWORDS = [
  'def', 'type', 'law', 'match', 'case', 'do', 'return', 'for', 'exs', 'where',
  'import', 'as', 'is', 'Type', 'Data', 'Kind', 'Quant', 'Nat', 'U32', 'F32',
  'String', 'Char', 'Bool', 'Unit', 'List', 'Array', 'Map', 'Set', 'Maybe',
  'Result', 'Equal', 'IO', 'True', 'False', 'None', 'Some', 'Fail', 'Done'
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
    if (')>]}'.includes(char)) depth = Math.max(0, depth - 1);
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

function addNames(target, source, detail, line, offset = 0, type) {
  const matcher = /(?:^|[^A-Za-z0-9_])([+\-~]?)([a-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const name = match[2];
    if (!RESERVED_BINDINGS.has(name)) {
      const prefixLength = match[0].length - match[1].length - name.length;
      target.set(name, {
        name,
        detail,
        type,
        line,
        character: offset + match.index + prefixLength + match[1].length
      });
    }
  }
}

function visibleBindings(text, position) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const endLine = Math.min(position.line, lines.length - 1);
  let declarationLine = -1;
  for (let line = endLine; line >= 0; line -= 1) {
    if (/^(?:@unsafe\s+)?(?:def|law)\s+/.test(lines[line])) {
      declarationLine = line;
      break;
    }
    if (/^(?:@unsafe\s+)?(?:def|type|law)\s+/.test(lines[line])) break;
  }
  if (declarationLine < 0) return [];

  const bindings = new Map();
  let parameterSearch = Math.max(0, lines[declarationLine].indexOf('(') + 1);
  for (const parameter of parameterList(lines[declarationLine])) {
    const binding = bindingFromParameter(parameter, declarationLine);
    if (binding) {
      binding.character = lines[declarationLine].indexOf(binding.name, parameterSearch);
      parameterSearch = binding.character + binding.name.length;
      bindings.set(binding.name, binding);
    }
  }

  for (let line = declarationLine + 1; line <= endLine; line += 1) {
    let value = lines[line];
    if (line === position.line) value = value.slice(0, position.character);

    const quantifier = value.match(/^\s*(?:for|exs)\s+([+\-]?[A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^\s]+))?/);
    if (quantifier) {
      addNames(
        bindings,
        quantifier[1],
        quantifier[2] ? `binder: ${quantifier[2]}` : 'binder',
        line,
        value.indexOf(quantifier[1]),
        quantifier[2]
      );
    }

    const caseMatch = value.match(/^\s*case\s+(.+):\s*$/);
    if (caseMatch) addNames(bindings, caseMatch[1].replace(/[A-Z][A-Za-z0-9_]*(?=\s*\{)/g, ''), 'pattern binding', line, value.indexOf(caseMatch[1]));

    const lambda = value.match(/([+\-]?[a-z_][A-Za-z0-9_]*)\s*=>/);
    if (lambda) addNames(bindings, lambda[1], 'lambda parameter', line, value.indexOf(lambda[1]));

    const assignment = value.match(/^\s*(.+?)\s*(?:<-|=)\s*[^=>]/);
    if (assignment) {
      const annotated = assignment[1].match(/^\s*[+\-]?([a-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
      const left = assignment[1].replace(/:[^,)}]+/g, '');
      addNames(
        bindings,
        left.replace(/[A-Z][A-Za-z0-9_]*(?=\s*\{)/g, ''),
        annotated ? `local binding: ${annotated[2]}` : 'local binding',
        line,
        value.indexOf(assignment[1]),
        annotated?.[2]
      );
    }
  }
  return [...bindings.values()];
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
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const before = lines.slice(0, position.line).concat((lines[position.line] || '').slice(0, position.character)).join('\n');
  let depth = 0;
  let commas = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const char = before[index];
    if (char === ')') depth += 1;
    else if (char === '(') {
      if (depth === 0) {
        const nameMatch = before.slice(0, index).match(/([A-Za-z_][A-Za-z0-9_.]*)!?\s*$/);
        return nameMatch ? { name: nameMatch[1], activeParameter: commas } : undefined;
      }
      depth -= 1;
    } else if (char === ',' && depth === 0) commas += 1;
  }
  return undefined;
}

module.exports = {
  BASE_MEMBERS,
  KEYWORDS,
  callContext,
  completionContext,
  parameterList,
  splitTopLevel,
  visibleBindings
};
