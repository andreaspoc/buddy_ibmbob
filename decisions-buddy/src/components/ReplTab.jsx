import React, { useState } from 'react';
import { apiRequest } from '../config.js';
import {
  Grid,
  Column,
  TextInput,
  TextArea,
  Button,
  Tile,
  Tag,
  CodeSnippet
} from '@carbon/react';
import { Play } from '@carbon/icons-react';


export default function ReplTab({ backendConnected }) {
  // Unary Test state
  const [unaryTest, setUnaryTest] = useState('> 100');
  const [unaryValue, setUnaryValue] = useState('150');
  const [unaryResult, setUnaryResult] = useState(null);
  const [unaryError, setUnaryError] = useState(null);
  const [unaryLoading, setUnaryLoading] = useState(false);

  // Expression Test state
  const [expression, setExpression] = useState('cart.total * (1 - 0.15)');
  const [contextJson, setContextJson] = useState('{\n  "cart": {\n    "total": 240\n  }\n}');
  const [exprResult, setExprResult] = useState(null);
  const [exprError, setExprError] = useState(null);
  const [exprLoading, setExprLoading] = useState(false);

  const handleRunUnary = async () => {
    setUnaryError(null);
    setUnaryResult(null);
    let parsedVal = unaryValue;
    if (!Number.isNaN(Number(unaryValue)) && unaryValue.trim() !== '') {
      parsedVal = Number(unaryValue);
    } else if (unaryValue === 'true') {
      parsedVal = true;
    } else if (unaryValue === 'false') {
      parsedVal = false;
    }

    if (!backendConnected) {
      setUnaryError('The decision service is unavailable. No local code was executed.');
      return;
    }

    setUnaryLoading(true);
    try {
      const data = await apiRequest('/evaluate/unary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: unaryTest, value: parsedVal })
      });
      setUnaryResult(data);
    } catch (e) {
      setUnaryError(e.message);
    } finally {
      setUnaryLoading(false);
    }
  };

  const handleRunExpression = async () => {
    setExprError(null);
    setExprResult(null);
    let parsedCtx = {};
    try {
      parsedCtx = JSON.parse(contextJson);
    } catch (e) {
      setExprError(`Context JSON Error: ${e.message}`);
      return;
    }

    if (!backendConnected) {
      setExprError('The decision service is unavailable. No local code was executed.');
      return;
    }

    setExprLoading(true);
    try {
      const data = await apiRequest('/evaluate/expression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression, context: parsedCtx })
      });
      if (data.status === 'error') {
        setExprError(data.error);
      } else {
        setExprResult(data.result);
      }
    } catch (e) {
      setExprError(e.message);
    } finally {
      setExprLoading(false);
    }
  };

  const sampleUnaryTests = [
    { test: '>= 100', val: '120', label: 'Comparison (>= 100)' },
    { test: '[18..65]', val: '25', label: 'Range [18..65]' },
    { test: "in ['VIP', 'Platinum']", val: 'VIP', label: "Membership (in ['VIP'])" },
    { test: "not in ['FRAUD', 'BLOCKED']", val: 'ACTIVE', label: 'Exclusion (not in)' },
    { test: "startsWith('US-')", val: 'US-90210', label: 'Prefix (startsWith)' },
    { test: "endsWith(?, '@gorules.io')", val: 'engineer@gorules.io', label: 'Placeholder (endsWith(?, ...))' },
    { test: "matches(?, '^[A-Z]{3}-\\d{3}$')", val: 'ABC-123', label: 'Regex (matches(?, ...))' },
    { test: '? >= 10 and ? <= 50', val: '25', label: 'Range (? >= 10 and ? <= 50)' },
    { test: 'is not null', val: 'Hello', label: 'Null Check (is not null)' }
  ];

  const sampleExpressions = [
    { expr: "map(orders, 'total')", ctx: JSON.stringify({ orders: [{ total: 10 }, { total: 20 }, { total: 30 }] }, null, 2), label: 'map(orders, total)' },
    { expr: "filter(items, 'active')", ctx: JSON.stringify({ items: [{ name: 'A', active: true }, { name: 'B', active: false }] }, null, 2), label: 'filter(items, active)' },
    { expr: "unique([1, 2, 2, 3, 1])", ctx: '{}', label: 'unique([1,2,2,3])' },
    { expr: "join(['a', 'b', 'c'], '-')", ctx: '{}', label: "join(['a','b','c'], '-')" }
  ];

  return (
    <div className="decisions-mt-06" >
      <Tile className="decisions-mb-06" >
        <h4 className="decisions-type-heading-02 decisions-m-00-00-03-00" >DecisionsBuddy Expression & Unary REPL</h4>
        <p className="decisions-type-body-compact-01 decisions-m-00" style={{ color: 'var(--cds-text-secondary)' }}>
          Directly test unary conditions used in Decision Tables and full DecisionsBuddy expressions with isolated evaluation.
        </p>
      </Tile>

      <Grid fullWidth>
        {/* Unary Test Column */}
        <Column lg={8} md={8} sm={4}>
          <Tile>
            <h5 className="decisions-type-heading-02 decisions-mb-04" >1. Unary Test Evaluator</h5>
            <p className="decisions-type-body-compact-01 decisions-mb-05" style={{ color: 'var(--cds-text-secondary)' }}>
              Used in Decision Table columns to test cell conditions against input variables.
            </p>

            <div className="decisions-mb-05" >
              <div className="decisions-type-label-01 decisions-mb-03" style={{ color: 'var(--cds-text-secondary)' }}>
                Quick Presets:
              </div>
              <div className="decisions-gap-03" style={{ display: 'flex', flexWrap: 'wrap' }}>
                {sampleUnaryTests.map((preset, idx) => (
                  <Button
                    key={idx}
                    kind="tertiary"
                    size="sm"
                    onClick={() => {
                      setUnaryTest(preset.test);
                      setUnaryValue(preset.val);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <TextInput
              id="unary-test-input"
              labelText="Unary Condition Expression"
              value={unaryTest}
              onChange={(e) => setUnaryTest(e.target.value)}
              placeholder="e.g. > 100, [18..65], in ['VIP', 'Gold']"
              className="decisions-mb-05" 
            />

            <TextInput
              id="unary-value-input"
              labelText="Test Input Value"
              value={unaryValue}
              onChange={(e) => setUnaryValue(e.target.value)}
              placeholder="e.g. 150, 'VIP', 'CA'"
              className="decisions-mb-06" 
            />

            <Button kind="primary" size="md" renderIcon={Play} onClick={handleRunUnary} disabled={!backendConnected || unaryLoading}>
              {unaryLoading ? 'Evaluating…' : 'Test Unary Condition'}
            </Button>

            {unaryError && (
              <div className="decisions-type-body-compact-01 decisions-mt-05" style={{ color: 'var(--cds-support-error)' }}>
                {unaryError}
              </div>
            )}

            {unaryResult && (
              <div
                className="decisions-mt-06 decisions-p-05" style={{ borderRadius: '4px', backgroundColor: unaryResult.passed ? 'rgba(36, 161, 72, 0.15)' : 'rgba(218, 30, 40, 0.15)', borderLeft: `4px solid ${unaryResult.passed ? 'var(--cds-support-success)' : 'var(--cds-support-error)'}` }}
              >
                <div className="decisions-gap-03 decisions-mb-02" style={{ display: 'flex', alignItems: 'center' }}>
                  <Tag type={unaryResult.passed ? 'green' : 'red'} size="sm">
                    {unaryResult.passed ? 'PASSED (TRUE)' : 'FAILED (FALSE)'}
                  </Tag>
                </div>
                <div className="decisions-type-code-01" >
                  {unaryResult.details}
                </div>
              </div>
            )}
          </Tile>
        </Column>

        {/* Standard Expression Column */}
        <Column lg={8} md={8} sm={4}>
          <Tile>
            <h5 className="decisions-type-heading-02 decisions-mb-04" >2. Standard Expression Evaluator</h5>
            <p className="decisions-type-body-compact-01 decisions-mb-05" style={{ color: 'var(--cds-text-secondary)' }}>
              Used in Expression nodes and dynamic output transformations with built-in functions.
            </p>

            <div className="decisions-mb-05" >
              <div className="decisions-type-label-01 decisions-mb-03" style={{ color: 'var(--cds-text-secondary)' }}>
                Quick Presets:
              </div>
              <div className="decisions-gap-03" style={{ display: 'flex', flexWrap: 'wrap' }}>
                {sampleExpressions.map((preset, idx) => (
                  <Button
                    key={idx}
                    kind="tertiary"
                    size="sm"
                    onClick={() => {
                      setExpression(preset.expr);
                      setContextJson(preset.ctx);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <TextInput
              id="expr-text-input"
              labelText="DecisionsBuddy Expression"
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
              placeholder="e.g. round(cart.total * 0.15, 2)"
              className="decisions-mb-05" 
            />

            <TextArea
              id="expr-context-input"
              labelText="Evaluation Context (JSON)"
              rows={8}
              value={contextJson}
              onChange={(e) => setContextJson(e.target.value)}
              className="decisions-json-editor decisions-mb-06"
              style={{ minHeight: '180px' }}
            />


            <Button kind="secondary" size="md" renderIcon={Play} onClick={handleRunExpression} disabled={!backendConnected || exprLoading}>
              {exprLoading ? 'Evaluating…' : 'Evaluate Expression'}
            </Button>

            {exprError && (
              <div className="decisions-type-body-compact-01 decisions-mt-05" style={{ color: 'var(--cds-support-error)' }}>
                {exprError}
              </div>
            )}

            {exprResult !== null && !exprError && (
              <div className="decisions-mt-06" >
                <div className="decisions-type-label-01 decisions-mb-02" style={{ color: 'var(--cds-text-secondary)' }}>
                  EVALUATION RESULT:
                </div>
                <CodeSnippet type="single">
                  {JSON.stringify(exprResult)}
                </CodeSnippet>
              </div>
            )}
          </Tile>
        </Column>
      </Grid>
    </div>
  );
}
