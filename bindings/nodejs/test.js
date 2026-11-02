/**
 * Automated test suite for Zen-Engine Node.js language binding.
 */
const assert = require('assert');
const { ZenEngine, evaluateUnary, safeEvalExpression } = require('./index');

async function runTests() {
  console.log('Testing Node.js Zen-Engine Binding...');

  // 1. Unary placeholder test
  const r1 = evaluateUnary("endsWith(?, '@gorules.io')", 'admin@gorules.io');
  assert.strictEqual(r1.passed, true, 'endsWith with ? should pass');

  const r2 = evaluateUnary("matches(?, '^[A-Z]{3}-\\d{3}$')", 'ABC-123');
  assert.strictEqual(r2.passed, true, 'matches with ? should pass');

  const r3 = evaluateUnary('? >= 10 and ? <= 50', 25);
  assert.strictEqual(r3.passed, true, 'range with ? should pass');

  const r4 = evaluateUnary("not(in ['FRAUD', 'BLOCKED'])", 'ACTIVE');
  assert.strictEqual(r4.passed, true, 'not(in [...]) should pass');

  const r5 = evaluateUnary("10, 20, 30", 20);
  assert.strictEqual(r5.passed, true, 'comma-separated list should pass');

  // Comparison whitespace is scanned once, including malformed multiline input.
  assert.strictEqual(evaluateUnary('>= \t\n 10', 12).passed, true);
  assert.strictEqual(evaluateUnary('>= 10\nextra', 12).passed, false);
  assert.strictEqual(evaluateUnary('>= ' + ' '.repeat(100000) + '10', 12).passed, true);
  assert.strictEqual(evaluateUnary('[1..3]', 'not numeric').passed, false);
  assert.strictEqual(evaluateUnary('>= 10', '12').passed, true);

  // 2. Builtin expressions
  const ctx = {
    orders: [{ total: 100 }, { total: 200 }],
    users: [{ role: 'admin' }, { role: 'user' }, { role: 'admin' }]
  };
  assert.deepStrictEqual(safeEvalExpression("map(orders, 'total')", ctx), [100, 200]);
  assert.strictEqual(safeEvalExpression("filter(users, 'role', 'admin')", ctx).length, 2);
  assert.deepStrictEqual(safeEvalExpression("unique([1, 2, 2, 3])", {}), [1, 2, 3]);
  assert.strictEqual(safeEvalExpression("join(['a', 'b'], '-')", {}), 'a-b');

  // Restricted expressions retain arithmetic, nested ternaries and lazy branches.
  assert.ok(Math.abs(safeEvalExpression('round(cart.total * 0.1, 2)', {cart: {total: 123.45}}) - 12.35) < 1e-10);
  assert.ok(Math.abs(safeEvalExpression('Math.pow(2, 3) + Math.PI', {}) - (8 + Math.PI)) < 1e-10);
  assert.strictEqual(safeEvalExpression('True and not False ? (2 > 3 ? 1 : 7) : missing()', {}), 7);
  assert.strictEqual(safeEvalExpression('false && missing()', {}), false);
  assert.strictEqual(safeEvalExpression('orders[0].total + orders[1]["total"]', ctx), 300);
  assert.strictEqual(safeEvalExpression("'and ? or'", {}), 'and ? or');
  assert.strictEqual(safeEvalExpression('JSON.parse(\'{"value":4}\').value', {}), 4);

  // These formerly reached host globals or constructors. No payload is executed.
  const attacks = [
    '(globalThis.reviewProof = 42)', 'process.env', 'require("fs")',
    'globalThis', '({}).constructor', 'orders.constructor',
    'orders["con" + "structor"]', 'orders.__proto__',
    'JSON.parse(\'{"constructor":1}\').constructor',
    'Math.constructor("return process")()', 'round.constructor("return process")()',
    'callback()', 'orders.map(callback)', 'new Function("return 1")()',
    '(()=>42)()', '1; 2', '`template`',
  ];
  for (const source of attacks) assert.throws(() => safeEvalExpression(source, ctx), undefined, source);
  assert.strictEqual(globalThis.reviewProof, undefined);
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'secret', {enumerable: true, get() {getterCalls++; return 42;}});
  assert.throws(() => safeEvalExpression('secret', accessor), /accessors/);
  assert.strictEqual(getterCalls, 0);
  assert.throws(() => safeEvalExpression('callback', {callback: () => 42}), /plain data/);
  assert.throws(() => safeEvalExpression('1'.repeat(16001), {}), /length limit/);
  assert.throws(() => safeEvalExpression('('.repeat(70) + '1' + ')'.repeat(70), {}), /nesting limit/);
  assert.throws(() => safeEvalExpression(Array(600).fill('1').join('+'), {}), /token limit/);
  const circular = {}; circular.self = circular;
  assert.throws(() => safeEvalExpression('self', circular), /data limit/);

  // 3. Complete Decision Table graph with ruleOrder hit policy
  const graph = {
    nodes: [
      { id: 'in', type: 'inputNode', content: {} },
      {
        id: 'tbl',
        type: 'decisionTableNode',
        content: {
          hitPolicy: 'ruleOrder',
          inputs: [{ id: 'score', field: 'score' }],
          outputs: [{ id: 'tier', field: 'tier' }],
          rules: [
            { _id: 'r1', score: '>= 50', tier: 'BRONZE' },
            { _id: 'r2', score: '>= 80', tier: 'SILVER' },
            { _id: 'r3', score: '>= 95', tier: 'GOLD' }
          ]
        }
      },
      { id: 'out', type: 'outputNode', content: {} }
    ],
    edges: [
      { sourceId: 'in', targetId: 'tbl' },
      { sourceId: 'tbl', targetId: 'out' }
    ]
  };

  const engine = new ZenEngine();
  const decision = engine.createDecision(graph);
  const evalRes = await decision.evaluate({ score: 85 }, { trace: true });

  assert(evalRes.performance, 'Performance timestamp should exist');
  assert.deepStrictEqual(evalRes.result.tbl, [
    { tier: 'BRONZE' },
    { tier: 'SILVER' }
  ], 'Rule order matching rows should be returned in declaration order');

  // 4. Schema validation
  const schemaGraph = {
    nodes: [
      {
        id: 'in',
        type: 'inputNode',
        content: {
          schema: {
            type: 'object',
            required: ['age'],
            properties: { age: { type: 'integer', minimum: 18 } }
          }
        }
      },
      { id: 'out', type: 'outputNode', content: {} }
    ],
    edges: [{ sourceId: 'in', targetId: 'out' }]
  };
  const schemaDecision = engine.createDecision(schemaGraph);
  const validRes = await schemaDecision.evaluate({ age: 21 });
  assert.strictEqual(validRes.result.age, 21);

  await assert.rejects(async () => {
    await schemaDecision.evaluate({ age: 15 });
  }, /is less than minimum/);

  console.log('All Node.js Zen-Engine tests passed successfully!');
}

module.exports = { runTests };
if (require.main === module) {
  runTests().catch(err => {
    console.error('Test failure:', err);
    process.exitCode = 1;
  });
}
