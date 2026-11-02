/**
 * GoRules Zen-Engine Compatible Node.js / TypeScript Language Binding.
 * Executes JSON Decision Model (JDM) graphs in-process with microsecond performance.
 */

'use strict';

function getByPath(obj, path) {
  if (!path || path === '$' || obj == null) return obj;
  const normalized = String(path).replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '');
  const parts = normalized.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr == null) return undefined;
    curr = curr[part];
  }
  return curr;
}

function setByPath(obj, path, value) {
  if (!path || path === '$') {
    if (typeof value === 'object' && value !== null) {
      Object.assign(obj, value);
    }
    return;
  }
  const parts = String(path).split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (curr[part] == null || typeof curr[part] !== 'object') {
      curr[part] = {};
    }
    curr = curr[part];
  }
  curr[parts[parts.length - 1]] = value;
}

const BUILTINS = {
  sum: (arr) => Array.isArray(arr) ? arr.reduce((acc, v) => acc + (Number(v) || 0), 0) : 0,
  avg: (arr) => Array.isArray(arr) && arr.length > 0 ? (arr.reduce((acc, v) => acc + (Number(v) || 0), 0) / arr.length) : 0,
  min: (...args) => {
    const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return list.length ? Math.min(...list.map(Number)) : 0;
  },
  max: (...args) => {
    const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return list.length ? Math.max(...list.map(Number)) : 0;
  },
  count: (arr) => Array.isArray(arr) ? arr.length : (arr != null ? 1 : 0),
  len: (arr) => Array.isArray(arr) || typeof arr === 'string' ? arr.length : 0,
  round: (num, dec = 0) => {
    const n = Number(num) || 0;
    const factor = Math.pow(10, dec);
    return Math.round(n * factor) / factor;
  },
  floor: (num) => Math.floor(Number(num) || 0),
  ceil: (num) => Math.ceil(Number(num) || 0),
  abs: (num) => Math.abs(Number(num) || 0),
  contains: (container, item) => {
    if (Array.isArray(container)) return container.includes(item);
    if (typeof container === 'string') return container.includes(String(item));
    return false;
  },
  startsWith: (str, prefix) => typeof str === 'string' && typeof prefix === 'string' && str.startsWith(prefix),
  starts_with: (str, prefix) => typeof str === 'string' && typeof prefix === 'string' && str.startsWith(prefix),
  endsWith: (str, suffix) => typeof str === 'string' && typeof suffix === 'string' && str.endsWith(suffix),
  ends_with: (str, suffix) => typeof str === 'string' && typeof suffix === 'string' && str.endsWith(suffix),
  matches: (str, regexStr) => {
    if (typeof str !== 'string' || typeof regexStr !== 'string') return false;
    try { return new RegExp(regexStr).test(str); } catch { return false; }
  },
  map: (arr, field) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => (typeof item === 'object' && item !== null ? item[field] : undefined));
  },
  filter: (arr, field, expected) => {
    if (!Array.isArray(arr)) return [];
    if (expected !== undefined) {
      return arr.filter(item => typeof item === 'object' && item !== null && item[field] === expected);
    }
    return arr.filter(item => typeof item === 'object' && item !== null ? Boolean(item[field]) : Boolean(item));
  },
  find: (arr, field, expected) => {
    if (!Array.isArray(arr)) return null;
    return arr.find(item => typeof item === 'object' && item !== null && item[field] === expected) || null;
  },
  flatten: (arr) => Array.isArray(arr) ? arr.flat(Infinity) : [],
  unique: (arr) => Array.isArray(arr) ? [...new Set(arr)] : [],
  join: (arr, sep = ',') => Array.isArray(arr) ? arr.join(sep) : '',
  split: (str, sep = ',') => typeof str === 'string' ? str.split(sep) : [],
  replace: (str, target, replacement) => typeof str === 'string' ? str.split(target).join(replacement) : '',
  slice: (arr, start, end) => (Array.isArray(arr) || typeof arr === 'string') ? arr.slice(start, end) : []
};

const { evaluateExpression } = require('./expression');

// Expressions accept plain JSON-like context data and approved builtins only.
// JavaScript statements, callbacks, constructors and object methods are rejected.
function safeEvalExpression(expr, context = {}) {
  if (typeof expr !== 'string') return expr;
  const code = expr.trim();
  if (!code) return null;
  return evaluateExpression(code, context, BUILTINS);
}

function parseLiteral(str) {
  const s = String(str).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function replacePlaceholders(s) {
  let inSingle = false;
  let inDouble = false;
  let hasPlaceholder = false;
  let result = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble && (i === 0 || s[i - 1] !== '\\')) {
      inSingle = !inSingle;
      result += ch;
    } else if (ch === '"' && !inSingle && (i === 0 || s[i - 1] !== '\\')) {
      inDouble = !inDouble;
      result += ch;
    } else if (!inSingle && !inDouble && (ch === '?' || ch === '$')) {
      hasPlaceholder = true;
      result += ' _unary_val_ ';
    } else {
      result += ch;
    }
  }
  return { hasPlaceholder, subbed: result };
}

function evaluateUnary(unaryTest, val, context = {}) {
  const s = String(unaryTest || '').trim();
  if (!s || s === '-' || s === '') {
    return { passed: true, details: 'Always true (-)' };
  }

  // Dynamic placeholder ? or $ (only outside string literals)
  const ph = replacePlaceholders(s);
  if (ph.hasPlaceholder) {
    try {
      const res = Boolean(safeEvalExpression(ph.subbed, { ...context, _unary_val_: val }));
      return { passed: res, details: `${s} evaluated with ?=${val} -> ${res}` };
    } catch (e) {
      return { passed: false, details: `Placeholder evaluation error: ${e.message}` };
    }
  }

  // Negation wrapper: not(...)
  const notMatch = s.match(/^not\s*\((.*)\)$/i);
  if (notMatch) {
    const innerRes = evaluateUnary(notMatch[1].trim(), val, context);
    return { passed: !innerRes.passed, details: `not(${notMatch[1]}) -> ${!innerRes.passed}` };
  }

  // Quoted literal
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const lit = s.slice(1, -1);
    return { passed: val === lit, details: `${val} === ${lit} -> ${val === lit}` };
  }

  // Null checks
  if (s === 'is null' || s === 'null') {
    return { passed: val == null, details: `${val} is null -> ${val == null}` };
  }
  if (s === 'is not null') {
    return { passed: val != null, details: `${val} is not null -> ${val != null}` };
  }

  // Booleans
  if (s === 'true') return { passed: Boolean(val) === true, details: `${val} == true` };
  if (s === 'false') return { passed: Boolean(val) === false, details: `${val} == false` };

  // in [...]
  const inMatch = s.match(/^in\s*\[(.*)\]$/i);
  if (inMatch) {
    const items = inMatch[1].split(',').map(parseLiteral);
    const passed = items.some(item => item === val || String(item) === String(val));
    return { passed, details: `${val} in [${items}] -> ${passed}` };
  }

  // not in [...]
  const notInMatch = s.match(/^not\s+in\s*\[(.*)\]$/i);
  if (notInMatch) {
    const items = notInMatch[1].split(',').map(parseLiteral);
    const passed = !items.some(item => item === val || String(item) === String(val));
    return { passed, details: `${val} not in [${items}] -> ${passed}` };
  }

  // Comma-separated list shorthand
  if (s.includes(',') && !s.startsWith('[') && !s.startsWith('(') && !/^in\s+/i.test(s) && !/^not\s+in\s+/i.test(s)) {
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const passed = parts.some(p => evaluateUnary(p, val, context).passed);
      return { passed, details: `${val} in (${s}) -> ${passed}` };
    }
  }

  // Range: [min..max]
  const rangeMatch = s.match(/^([\[\(])\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*([\]\)])$/);
  if (rangeMatch) {
    const [, lBr, minStr, maxStr, rBr] = rangeMatch;
    const minV = Number(minStr);
    const maxV = Number(maxStr);
    const num = Number(val);
    if (Number.isNaN(num)) return { passed: false, details: 'Value is not a number' };
    const minPass = lBr === '[' ? num >= minV : num > minV;
    const maxPass = rBr === ']' ? num <= maxV : num < maxV;
    const passed = minPass && maxPass;
    return { passed, details: `${num} in ${lBr}${minV}..${maxV}${rBr} -> ${passed}` };
  }

  // Comparisons: >=, <=, !=, ==, =, >, <
  const compMatch = s.match(/^(>=|<=|!=|==|=|>|<)/);
  const comparisonValue = compMatch ? s.slice(compMatch[0].length).trimStart() : '';
  if (compMatch && !/[\r\n\u2028\u2029]/.test(comparisonValue)) {
    const op = compMatch[1] === '=' ? '==' : compMatch[1];
    const target = parseLiteral(comparisonValue);
    const numVal = Number(val);
    const numTarget = Number(target);
    const useNum = !Number.isNaN(numVal) && !Number.isNaN(numTarget) && typeof val !== 'boolean' && typeof target !== 'boolean';
    const a = useNum ? numVal : val;
    const b = useNum ? numTarget : target;

    let passed = false;
    if (op === '>=') passed = a >= b;
    else if (op === '<=') passed = a <= b;
    else if (op === '>') passed = a > b;
    else if (op === '<') passed = a < b;
    else if (op === '==') passed = (a === b || String(a) === String(b));
    else if (op === '!=') passed = (a !== b && String(a) !== String(b));
    return { passed, details: `${val} ${op} ${target} -> ${passed}` };
  }

  // Exact fallback match
  const lit = parseLiteral(s);
  const passed = (val === lit || String(val) === String(lit));
  return { passed, details: `${val} == ${lit} -> ${passed}` };
}

function evaluateDecisionTable(content, context) {
  const hitPolicy = (content.hitPolicy || 'first').toLowerCase();
  const inputs = content.inputs || [];
  const outputs = content.outputs || [];
  const rules = content.rules || [];

  const matchedOutputs = [];
  const ruleTrace = [];

  for (const rule of rules) {
    let rulePassed = true;
    for (const inp of inputs) {
      const colId = inp.id;
      const fieldPath = inp.field || colId;
      const cellVal = rule[colId];
      if (cellVal === undefined || cellVal === null || String(cellVal).trim() === '-' || String(cellVal).trim() === '') {
        continue;
      }
      const contextVal = getByPath(context, fieldPath);
      const res = evaluateUnary(cellVal, contextVal, context);
      if (!res.passed) {
        rulePassed = false;
        break;
      }
    }

    ruleTrace.push({ ruleId: rule._id, passed: rulePassed });

    if (rulePassed) {
      const rowOutput = {};
      for (const out of outputs) {
        const colId = out.id;
        const fieldPath = out.field || colId;
        const rawExpr = rule[colId];
        let val = null;
        if (rawExpr !== undefined && rawExpr !== null) {
          const s = String(rawExpr).trim();
          if (s.startsWith('=') || s.includes('?') || s.includes('+') || s.includes('-') || s.includes('*') || s.includes('/')) {
            const cleanExpr = s.startsWith('=') ? s.slice(1).trim() : s;
            try { val = safeEvalExpression(cleanExpr, context); } catch { val = parseLiteral(cleanExpr); }
          } else {
            val = parseLiteral(s);
          }
        }
        setByPath(rowOutput, fieldPath, val);
      }

      if (hitPolicy === 'first') {
        return { result: rowOutput, ruleTrace };
      }
      matchedOutputs.push(rowOutput);
    }
  }

  if (hitPolicy === 'first') {
    return { result: {}, ruleTrace };
  }

  // ruleOrder or collect
  return { result: matchedOutputs, ruleTrace };
}

function validateJsonSchema(data, schema, path = 'data') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const expectedType = schema.type;
    const actualType = Array.isArray(data) ? 'array' : (data === null ? 'null' : typeof data);
    if (expectedType === 'integer' && (!Number.isInteger(data))) {
      errors.push(`${path}: expected integer, got ${actualType}`);
    } else if (expectedType === 'number' && typeof data !== 'number') {
      errors.push(`${path}: expected number, got ${actualType}`);
    } else if (expectedType === 'boolean' && typeof data !== 'boolean') {
      errors.push(`${path}: expected boolean, got ${actualType}`);
    } else if (expectedType === 'string' && typeof data !== 'string') {
      errors.push(`${path}: expected string, got ${actualType}`);
    } else if (expectedType === 'array' && !Array.isArray(data)) {
      errors.push(`${path}: expected array, got ${actualType}`);
    } else if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(data))) {
      errors.push(`${path}: expected object, got ${actualType}`);
    }
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${path}: value ${data} is less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${path}: value ${data} is greater than maximum ${schema.maximum}`);
    }
  }

  if (schema.required && Array.isArray(schema.required) && typeof data === 'object' && data !== null) {
    for (const req of schema.required) {
      if (data[req] === undefined || data[req] === null) {
        errors.push(`${path}.${req} is required`);
      }
    }
  }

  if (schema.properties && typeof data === 'object' && data !== null) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (data[key] !== undefined) {
        errors.push(...validateJsonSchema(data[key], propSchema, `${path}.${key}`));
      }
    }
  }

  return errors;
}

class ZenDecisionContent {
  constructor(content) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
      content = content.toString('utf-8');
    }
    if (typeof content === 'string') {
      this.data = JSON.parse(content);
    } else if (typeof content === 'object' && content !== null) {
      this.data = JSON.parse(JSON.stringify(content));
    } else {
      throw new TypeError(`Invalid decision content type: ${typeof content}`);
    }
    this.graph = (this.data.graph && typeof this.data.graph === 'object') ? this.data.graph : this.data;
  }
}

class ZenDecision {
  constructor(content, engine = null) {
    this._content = content instanceof ZenDecisionContent ? content : new ZenDecisionContent(content);
    this._engine = engine;
    this.graph = this._content.graph;
  }

  evaluateSync(context = {}, options = {}) {
    const startNs = process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now() * 1000000);
    const nodes = (this.graph.nodes || []).reduce((acc, n) => { acc[n.id] = n; return acc; }, {});
    const edges = this.graph.edges || [];

    // In-degree & topological sort
    const outEdges = {};
    const inDegrees = {};
    for (const nid of Object.keys(nodes)) inDegrees[nid] = 0;
    for (const edge of edges) {
      const src = edge.sourceId;
      const tgt = edge.targetId;
      if (!outEdges[src]) outEdges[src] = [];
      outEdges[src].push(edge);
      inDegrees[tgt] = (inDegrees[tgt] || 0) + 1;
    }

    const queue = Object.keys(inDegrees).filter(id => inDegrees[id] === 0);
    const execOrder = [];
    while (queue.length > 0) {
      const curr = queue.shift();
      execOrder.push(curr);
      for (const edge of (outEdges[curr] || [])) {
        inDegrees[edge.targetId]--;
        if (inDegrees[edge.targetId] === 0) queue.push(edge.targetId);
      }
    }

    if (execOrder.length < Object.keys(nodes).length) {
      throw new Error('Graph cycle detected in decision model');
    }

    const workingContext = JSON.parse(JSON.stringify(context));
    const traces = [];
    let finalResult = workingContext;

    for (const nid of execOrder) {
      const node = nodes[nid];
      const nodeType = node.type;
      const content = node.content || {};
      const nodeTrace = { id: node.id, name: node.name || node.id, type: nodeType };

      if (nodeType === 'inputNode') {
        if (content.schema) {
          const errs = validateJsonSchema(workingContext, content.schema, 'request');
          if (errs.length) throw new Error(`Input schema validation failed: ${errs.join('; ')}`);
        }
      } else if (nodeType === 'decisionTableNode') {
        const tableRes = evaluateDecisionTable(content, workingContext);
        nodeTrace.ruleTrace = tableRes.ruleTrace;
        nodeTrace.outputSnapshot = tableRes.result;
        if (Array.isArray(tableRes.result)) {
          workingContext[node.name || nid] = tableRes.result;
          workingContext.results = tableRes.result;
        } else if (typeof tableRes.result === 'object') {
          for (const [k, v] of Object.entries(tableRes.result)) {
            setByPath(workingContext, k, v);
          }
        }
      } else if (nodeType === 'expressionNode') {
        const expressions = content.expressions || [];
        const outVars = {};
        for (const exp of expressions) {
          const val = safeEvalExpression(exp.value, workingContext);
          outVars[exp.key] = val;
          setByPath(workingContext, exp.key, val);
        }
        nodeTrace.outputSnapshot = outVars;
      } else if (nodeType === 'outputNode') {
        if (content.schema && Array.isArray(content.schema)) {
          finalResult = {};
          for (const k of content.schema) finalResult[k] = getByPath(workingContext, k);
        } else if (content.schema && typeof content.schema === 'object') {
          const errs = validateJsonSchema(workingContext, content.schema, 'response');
          if (errs.length) throw new Error(`Output schema validation failed: ${errs.join('; ')}`);
          finalResult = { ...workingContext };
        } else {
          finalResult = { ...workingContext };
        }
        nodeTrace.outputSnapshot = finalResult;
      }
      traces.push(nodeTrace);
    }

    const endNs = process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now() * 1000000);
    const durationNs = Number(endNs - startNs);
    const perfStr = `${(durationNs / 1000).toFixed(1)}µs`;

    const output = {
      result: finalResult,
      performance: perfStr,
      performanceDetails: {
        durationNs,
        nodesExecuted: execOrder.length
      }
    };
    if (options && options.trace) output.trace = traces;
    return output;
  }

  async evaluate(context = {}, options = {}) {
    return this.evaluateSync(context, options);
  }

  dispose() {}
}

class ZenEngine {
  constructor(options = {}) {
    this.loader = options.loader || null;
    this._decisions = new Map();
  }

  createDecision(content) {
    return new ZenDecision(content, this);
  }

  async getDecision(key) {
    if (this._decisions.has(key)) return this._decisions.get(key);
    if (this.loader) {
      const content = await this.loader(key);
      if (content) {
        const dec = this.createDecision(content);
        this._decisions.set(key, dec);
        return dec;
      }
    }
    return null;
  }

  async evaluate(keyOrContent, contentOrContext, contextOrOptions, options) {
    if (contextOrOptions === undefined && options === undefined) {
      const dec = this.createDecision(keyOrContent);
      return dec.evaluate(contentOrContext);
    } else if (options === undefined && typeof keyOrContent === 'string' && typeof contentOrContext === 'object') {
      const dec = await this.getDecision(keyOrContent);
      if (!dec) throw new Error(`Decision "${keyOrContent}" not found`);
      return dec.evaluate(contentOrContext, contextOrOptions);
    } else {
      const dec = this.createDecision(contentOrContext);
      return dec.evaluate(contextOrOptions, options);
    }
  }

  dispose() {
    this._decisions.clear();
  }
}

module.exports = {
  ZenEngine,
  ZenDecision,
  ZenDecisionContent,
  evaluateUnary,
  safeEvalExpression
};
