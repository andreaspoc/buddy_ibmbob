'use strict';

// Deliberately a data-expression language: no JavaScript compilation, mutation,
// constructors, arbitrary methods, or access to inherited properties.
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const PRECEDENCE = { '||': 1, or: 1, '&&': 2, and: 2, '==': 3, '!=': 3,
  '===': 3, '!==': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '**': 7 };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function dataCopy(value, budget, depth = 0) {
  budget ??= { remaining: 20000 };
  if (--budget.remaining < 0 || depth > 40) throw new Error('Expression data limit exceeded');
  if (value === null || ['undefined', 'boolean', 'number', 'string'].includes(typeof value)) {
    if (typeof value === 'string' && value.length > 100000) throw new Error('Expression string limit exceeded');
    return value;
  }
  if (typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new Error('Expression context must contain plain data');
  }
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value')) throw new Error('Expression context cannot contain accessors');
    result[key] = dataCopy(descriptor.value, budget, depth + 1);
  }
  return result;
}

function tokenize(source) {
  if (source.length > 16000) throw new Error('Expression length limit exceeded');
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { offset += whitespace[0].length; continue; }
    let token;
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0]; let i = 1, value = '', closed = false;
      for (; i < rest.length; i++) {
        const character = rest[i];
        if (character === quote) { i++; closed = true; break; }
        if (character !== '\\') { value += character; continue; }
        const escape = rest[++i];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' };
        if (escape === 'u') {
          const hex = rest.slice(i + 1, i + 5);
          if (!/^[\da-f]{4}$/i.test(hex)) throw new Error('Invalid Unicode escape');
          value += String.fromCharCode(Number.parseInt(hex, 16)); i += 4;
        } else if (own(escapes, escape)) value += escapes[escape];
        // Preserve regex escapes used by existing matches() business rules.
        else if (escape !== undefined) value += '\\' + escape;
        else throw new Error('Unterminated string escape');
      }
      if (!closed) throw new Error('Unterminated string');
      token = { type: 'literal', value }; offset += i;
    } else {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
      const operator = /^(?:===|!==|\*\*|&&|\|\||==|!=|<=|>=|[+\-*/%<>()\[\].,?:!])/.exec(rest);
      if (number) { token = { type: 'literal', value: Number(number[0]) }; offset += number[0].length; }
      else if (identifier) { token = { type: 'identifier', value: identifier[0] }; offset += identifier[0].length; }
      else if (operator) { token = { type: 'operator', value: operator[0] }; offset += operator[0].length; }
      else throw new Error('Unsupported expression syntax');
    }
    tokens.push(token);
    if (tokens.length > 1024) throw new Error('Expression token limit exceeded');
  }
  tokens.push({ type: 'end', value: '' });
  return tokens;
}

function parse(source) {
  const tokens = tokenize(source); let position = 0, depth = 0;
  const current = () => tokens[position];
  const take = value => current().value === value && current().type !== 'literal' && (++position, true);
  const expect = value => { if (!take(value)) throw new Error(`Expected ${value}`); };
  function expression(minimum = 0) {
    if (++depth > 64) throw new Error('Expression nesting limit exceeded');
    let node;
    const token = current();
    if (['!', 'not', '+', '-'].includes(token.value) && token.type !== 'literal') {
      position++; node = { type: 'unary', operator: token.value, operand: expression(7) };
    } else if (take('(')) { node = expression(); expect(')'); }
    else if (take('[')) {
      const items = [];
      if (!take(']')) { do { items.push(expression()); } while (take(',')); expect(']'); }
      node = { type: 'array', items };
    } else if (token.type === 'literal') { position++; node = { type: 'literal', value: token.value }; }
    else if (token.type === 'identifier') {
      position++;
      const constants = { true: true, True: true, false: false, False: false, null: null, None: null };
      node = own(constants, token.value) ? { type: 'literal', value: constants[token.value] } : { type: 'name', name: token.value };
    } else throw new Error('Expected an expression');
    while (true) {
      if (take('.')) {
        const property = current();
        if (property.type !== 'identifier' || FORBIDDEN.has(property.value)) throw new Error('Forbidden property');
        position++; node = { type: 'member', object: node, property: { type: 'literal', value: property.value } };
      } else if (take('[')) { const property = expression(); expect(']'); node = { type: 'member', object: node, property }; }
      else if (take('(')) {
        const args = [];
        if (!take(')')) { do { args.push(expression()); } while (take(',')); expect(')'); }
        node = { type: 'call', callee: node, args };
      } else break;
    }
    while (own(PRECEDENCE, current().value) && current().type !== 'literal' && PRECEDENCE[current().value] >= minimum) {
      const operator = tokens[position++].value, precedence = PRECEDENCE[operator];
      node = { type: 'binary', operator, left: node, right: expression(precedence + (operator === '**' ? 0 : 1)) };
    }
    if (minimum === 0 && take('?')) {
      const yes = expression(); expect(':'); node = { type: 'conditional', condition: node, yes, no: expression() };
    }
    depth--; return node;
  }
  const result = expression();
  if (current().type !== 'end') throw new Error('Unexpected expression token');
  return result;
}

function evaluateExpression(source, context, builtins) {
  const tree = parse(source), data = dataCopy(context);
  const math = Object.create(null);
  for (const name of ['abs', 'ceil', 'floor', 'round', 'min', 'max', 'pow', 'sqrt', 'trunc', 'sign', 'log', 'log10', 'exp']) math[name] = Math[name];
  const constants = { PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, SQRT2: Math.SQRT2 };
  let remaining = 2048;
  const primitive = value => {
    if (value !== null && typeof value === 'object') throw new Error('Operators require primitive values');
    return value;
  };
  function run(node) {
    if (--remaining < 0) throw new Error('Expression operation limit exceeded');
    if (node.type === 'literal') return node.value;
    if (node.type === 'array') return node.items.map(run);
    if (node.type === 'name') {
      if (FORBIDDEN.has(node.name) || !own(data, node.name)) throw new Error(`Unknown expression name: ${node.name}`);
      return data[node.name];
    }
    if (node.type === 'member') {
      const key = primitive(run(node.property));
      if (!['string', 'number'].includes(typeof key) || FORBIDDEN.has(String(key))) throw new Error('Forbidden property');
      if (node.object.type === 'name' && node.object.name === 'Math' && own(constants, key)) return constants[key];
      const object = run(node.object);
      if (object == null || !own(Object(object), key)) return undefined;
      return object[key];
    }
    if (node.type === 'call') {
      let fn;
      if (node.callee.type === 'name' && own(builtins, node.callee.name)) fn = builtins[node.callee.name];
      else if (node.callee.type === 'member' && node.callee.object.type === 'name' && node.callee.object.name === 'Math') {
        const key = run(node.callee.property);
        if (typeof key === 'string' && own(math, key)) fn = math[key];
      } else if (node.callee.type === 'member' && node.callee.object.type === 'name' && node.callee.object.name === 'JSON') {
        const key = run(node.callee.property);
        if (key === 'stringify') fn = JSON.stringify;
        if (key === 'parse') fn = text => dataCopy(JSON.parse(text));
      }
      if (!fn) throw new Error('Only approved expression functions may be called');
      return dataCopy(fn(...node.args.map(run)));
    }
    if (node.type === 'conditional') return run(node.condition) ? run(node.yes) : run(node.no);
    if (node.type === 'unary') {
      const operand = primitive(run(node.operand));
      if (node.operator === '!' || node.operator === 'not') return !operand;
      return node.operator === '+' ? +operand : -operand;
    }
    const left = run(node.left);
    if (node.operator === '&&' || node.operator === 'and') return left && run(node.right);
    if (node.operator === '||' || node.operator === 'or') return left || run(node.right);
    const right = run(node.right);
    primitive(left); primitive(right);
    switch (node.operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right;
      case '%': return left % right;
      case '**': return left ** right;
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      case '==': return left == right;
      case '!=': return left != right;
      case '===': return left === right;
      case '!==': return left !== right;
      default: throw new Error('Unsupported expression operator');
    }
  }
  return dataCopy(run(tree));
}

module.exports = { evaluateExpression };
