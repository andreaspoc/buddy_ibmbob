import React, { useEffect, useRef, useState } from 'react';
import {
  Grid,
  Column,
  Select,
  SelectItem,
  TextArea,
  Button,
  Tag,
  Toggle,
  CodeSnippet,
  Accordion,
  AccordionItem,
  InlineNotification,
  Tile,
  TextInput,
  Table, TableHead, TableRow, TableHeader, TableBody, TableCell
} from '@carbon/react';
import { apiRequest } from '../config.js';
import { batchPayload, csvScenarios, parseCsv, parseScenarios, sameJson } from '../lib/simulationInputs.js';
import { Play, Reset, CheckmarkFilled, CloseFilled, DocumentImport } from '@carbon/icons-react';
import { downloadJson } from '../lib/downloadJson.js';

export default function SimulatorTab({
  selectedModelKey,
  setSelectedModelKey,
  models,
  inputJson,
  setInputJson,
  onEvaluate,
  evaluationResult,
  isLoading,
  backendConnected,
  editable = true
}) {
  const [jsonError, setJsonError] = useState(null);
  const [mode, setMode] = useState('single');
  const [batchJson, setBatchJson] = useState('[\n  {"input": {}, "expected": {}}\n]');
  const [batchResult, setBatchResult] = useState(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [notice, setNotice] = useState('');
  const [csvRows, setCsvRows] = useState(null);
  const [csvPath, setCsvPath] = useState('');
  const [parseCsvValues, setParseCsvValues] = useState(false);
  const [suiteRevision, setSuiteRevision] = useState(null);
  const [kpiConfigJson, setKpiConfigJson] = useState(JSON.stringify({
    title: 'Scenario impact report', includeCases: true,
    metrics: [{ name: 'Scenario count', expression: 'true', aggregation: 'count' }]
  }, null, 2));
  const [kpiResult, setKpiResult] = useState(null);
  const [baselineKey, setBaselineKey] = useState('');
  const currentModel = models[selectedModelKey];
  const signature = JSON.stringify([selectedModelKey, currentModel?.version, currentModel?._dirty, currentModel?.graph]);
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  const requestId = useRef(0);
  useEffect(() => {
    requestId.current += 1;
    setBatchResult(null); setBatchError(''); setNotice(''); setSuiteRevision(null);
    setCsvRows(null); setBatchBusy(false); setKpiResult(null);
  }, [signature]);
  let singleError = jsonError;
  try {
    const input = JSON.parse(inputJson);
    if (!input || typeof input !== 'object' || Array.isArray(input)) singleError = 'Single input must be a JSON object.';
  } catch (error) { singleError = error.message; }
  const savedClean = currentModel?.version && !currentModel._dirty;

  const editBatch = value => {
    requestId.current += 1; setBatchBusy(false); setBatchJson(value);
    setBatchResult(null); setKpiResult(null); setNotice(''); setBatchError('');
  };
  const handleJsonChange = event => { setInputJson(event.target.value); setJsonError(null); };
  const handleResetInput = () => { setInputJson(JSON.stringify(currentModel?.defaultInput || {}, null, 2)); setJsonError(null); };

  const handleUploadInputFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const key = signature;
    if (file.size > 1024 * 1024) { setBatchError('Import a file no larger than 1 MB.'); return; }
    try {
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('Cannot read workbook.'));
          reader.readAsDataURL(file);
        });
        const data = await apiRequest('/simulation/import-workbook', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentBase64: encoded })
        });
        if (currentSignature.current !== key) return;
        parseScenarios(JSON.stringify(data.cases));
        editBatch(JSON.stringify(data.cases, null, 2));
        setCsvRows(null); setMode('batch');
        return;
      }
      const text = await file.text();
      if (currentSignature.current !== key) return;
      if (file.name.toLowerCase().endsWith('.csv')) {
        requestId.current += 1; setBatchBusy(false); setKpiResult(null);
        setCsvRows(parseCsv(text)); setMode('batch'); setBatchError(''); setBatchResult(null);
      } else {
        const parsed = JSON.parse(text);
        if (mode === 'batch') { parseScenarios(text); editBatch(JSON.stringify(parsed, null, 2)); }
        else {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Single input must be an object. Switch to batch mode to import scenarios.');
          setInputJson(JSON.stringify(parsed, null, 2)); setJsonError(null);
        }
        setBatchError('');
      }
    } catch (error) { if (currentSignature.current === key) setBatchError(`Input import failed: ${error.message}`); }
  };

  const useCsv = () => {
    try {
      editBatch(JSON.stringify(csvScenarios(csvRows, { path: csvPath, parseValues: parseCsvValues }), null, 2));
      setCsvRows(null); setBatchResult(null); setBatchError('');
    } catch (error) { setBatchError(error.message); }
  };

  const batchRequest = async action => {
    const key = signature, id = ++requestId.current;
    setBatchBusy(true); setBatchError(''); setNotice(''); setBatchResult(null);
    try {
      if (!currentModel) throw new Error('Select a decision first.');
      if (action !== 'evaluate' && !savedClean) throw new Error('Save this draft before using version-bound saved tests.');
      const path = `/models/${encodeURIComponent(currentModel.id)}`;
      let data;
      if (action === 'load') {
        data = await apiRequest(`${path}/test-cases`);
        if (currentSignature.current === key && requestId.current === id) { setBatchJson(JSON.stringify(data.cases, null, 2)); setKpiResult(null); setSuiteRevision(data.suiteRevision); setNotice('Saved cases loaded.'); }
      } else if (action === 'save') {
        if (!editable) throw new Error('Editing this test suite requires edit access.');
        const cases = parseScenarios(batchJson);
        if (cases.some(item => !Object.hasOwn(item, 'expected') || !item.name?.trim())) throw new Error('Every saved case needs a name and explicit expected output.');
        if (suiteRevision === null) throw new Error('Load the saved cases first to check for concurrent edits.');
        data = await apiRequest(`${path}/test-cases`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: currentModel.version, expectedSuiteRevision: suiteRevision, cases }) });
        if (currentSignature.current === key && requestId.current === id) { setSuiteRevision(data.suiteRevision); setNotice('Test cases saved. Run the saved suite to record regression evidence.'); }
      } else if (action === 'saved') {
        data = await apiRequest(`${path}/run-tests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: currentModel.version }) });
        if (currentSignature.current === key && requestId.current === id) setBatchResult({ ...data, savedSuite: true });
      } else {
        const cases = parseScenarios(batchJson);
        data = await apiRequest('/evaluate/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batchPayload(currentModel, cases)) });
        if (!Array.isArray(data?.results) || data.results.length !== cases.length) throw new Error('Batch service returned an incomplete response.');
        if (currentSignature.current === key && requestId.current === id) setBatchResult({ ...data, results: data.results.map((result, index) => ({ ...result, name: cases[index].name || `Scenario ${index + 1}`, expected: cases[index].expected, actual: result.result, passed: Object.hasOwn(cases[index], 'expected') ? sameJson(cases[index].expected, result.result) : null })) });
      }
    } catch (error) { if (currentSignature.current === key && requestId.current === id) setBatchError(error.message); }
    finally { if (currentSignature.current === key && requestId.current === id) setBatchBusy(false); }
  };

  const invalidateKpis = () => {
    requestId.current += 1; setBatchBusy(false); setKpiResult(null); setBatchError('');
  };
  const runKpis = async () => {
    const key = signature, id = ++requestId.current;
    setBatchBusy(true); setBatchError(''); setKpiResult(null);
    try {
      if (!currentModel) throw new Error('Select a decision first.');
      const cases = parseScenarios(batchJson);
      const payload = batchPayload(currentModel, cases);
      delete payload.items;
      payload.cases = cases;
      payload.report = JSON.parse(kpiConfigJson);
      if (baselineKey) {
        const baseline = models[baselineKey];
        if (!baseline?.id || !baseline.version) throw new Error('Choose a saved baseline decision.');
        payload.baselineDecisionId = baseline.id;
        payload.baselineExpectedVersion = baseline.version;
      }
      const report = await apiRequest('/simulation/kpis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (currentSignature.current === key && requestId.current === id) setKpiResult(report);
    } catch (error) {
      if (currentSignature.current === key && requestId.current === id) setBatchError(error.message);
    } finally {
      if (currentSignature.current === key && requestId.current === id) setBatchBusy(false);
    }
  };

  return (
    <Grid fullWidth className="decisions-mt-06" >
      <Column lg={16} md={8} sm={4}>
        {batchError && <InlineNotification kind="error" title="Simulation request failed" subtitle={batchError} onCloseButtonClick={() => setBatchError('')} />}
        {notice && <InlineNotification kind="info" title={notice} onCloseButtonClick={() => setNotice('')} />}
        <Select id="simulation-input-mode" labelText="Simulation input mode" value={mode} onChange={event => { setMode(event.target.value); setBatchError(''); }}>
          <SelectItem value="single" text="Single input object" />
          <SelectItem value="batch" text="Independent batch scenarios and regression tests" />
        </Select>
      </Column>
      {/* Left Column: Configuration & Input */}
      <Column lg={7} md={8} sm={4}>
        <Tile className="decisions-mb-06" >
          <h4 className="decisions-type-heading-02 decisions-mb-03" >Decision Model Selection</h4>
          <p className="decisions-type-body-compact-01 decisions-mb-05" style={{ color: 'var(--cds-text-secondary)' }}>
            Choose a pre-configured Decision Model or customize the input context.
          </p>

          <Select
            id="decision-model-select"
            labelText="Select Decision Model"
            value={selectedModelKey}
            onChange={(e) => {
              const newKey = e.target.value;
              setSelectedModelKey(newKey);
              if (models[newKey]) {
                setInputJson(JSON.stringify(models[newKey].defaultInput, null, 2));
                setJsonError(null);
              }
            }}
          >
            {Object.keys(models).map((key) => (
              <SelectItem key={key} value={key} text={models[key].name} />
            ))}
          </Select>

          <p className="decisions-service-status">{backendConnected ? 'Simulation runs in the authenticated decision service.' : 'Connect to the decision service to simulate this model.'}</p>
        </Tile>

        <Tile>
          <div className="decisions-mb-04" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 className="decisions-type-heading-02 decisions-m-00" >{mode === 'single' ? 'Input Context (JSON)' : 'Batch Scenarios (JSON)'}</h4>
            <div className="decisions-gap-03" style={{ display: 'flex' }}>
              <input
                id="simulator-file-upload"
                type="file"
                accept=".json,.csv,.xlsx"
                style={{ display: 'none' }}
                onChange={handleUploadInputFile}
              />
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={DocumentImport}
                onClick={() => document.getElementById('simulator-file-upload').click()}
              >
                Import JSON / CSV / Excel
              </Button>
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Reset}
                onClick={handleResetInput}
                disabled={mode !== 'single'}
              >
                Reset Default
              </Button>
            </div>
          </div>


          <p className="decisions-type-body-compact-01 decisions-mb-04" style={{ color: 'var(--cds-text-secondary)' }}>
            {mode === 'single' ? "One object is passed into the graph input node." : 'Each scenario is evaluated independently: [{"name":"case name","input":{...},"expected":{...}}]. Expected outputs are optional for an ad hoc batch and required for saved tests.'}
          </p>

          {mode === 'batch' && <p><a href="/api/decisions/simulation/workbook-template" download>Download Excel scenario template</a>. The Scenarios sheet uses name, input and expected columns; input and expected contain JSON. Imported cases can be run and saved below.</p>}

          {csvRows && <Tile className="decisions-mb-05">
            <p>Imported {csvRows.length} CSV rows. Each row becomes one independent scenario. Headers map literally to input fields; no customer/items wrapper is guessed.</p>
            <TextInput id="csv-input-path" labelText="Place each row under this object path (optional)" placeholder="e.g. customer; empty means root input" value={csvPath} onChange={event => setCsvPath(event.target.value)} />
            <Toggle id="csv-parse-values" labelText="CSV value types" labelA="Keep all cells as strings" labelB="Parse JSON values; retain other cells as strings" toggled={parseCsvValues} onToggle={setParseCsvValues} />
            <Button kind="tertiary" onClick={useCsv}>Use CSV rows as batch scenarios</Button>
          </Tile>}
          <TextArea
            id="input-json-editor"
            labelText=""
            hideLabel
            rows={18}
            value={mode === 'single' ? inputJson : batchJson}
            onChange={mode === 'single' ? handleJsonChange : event => editBatch(event.target.value)}
            invalid={mode === 'single' && !!singleError}
            invalidText={mode === 'single' ? singleError || '' : ''}
            className="decisions-json-editor"
            style={{ minHeight: '360px' }}
          />


          <div className="decisions-mt-06" >
            <Button
              kind="primary"
              renderIcon={Play}
              onClick={mode === 'single' ? onEvaluate : () => batchRequest('evaluate')}
              disabled={isLoading || batchBusy || (mode === 'single' && !!singleError) || !backendConnected || (mode === 'batch' && !!csvRows)}
              style={{ width: '100%' }}
            >
              {isLoading || batchBusy ? 'Evaluating Decision...' : mode === 'single' ? 'Evaluate Decision' : 'Evaluate Independent Scenarios'}
            </Button>
          </div>
          {mode === 'batch' && <div className="decisions-gap-03 decisions-mt-05" style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Button kind="tertiary" disabled={!backendConnected || !savedClean || batchBusy} onClick={() => batchRequest('load')}>Load saved cases</Button>
            <Button kind="tertiary" disabled={!editable || !backendConnected || !savedClean || batchBusy || suiteRevision === null || !!csvRows} onClick={() => batchRequest('save')}>Save test cases</Button>
            <Button kind="secondary" disabled={!backendConnected || !savedClean || batchBusy} onClick={() => batchRequest('saved')}>Run saved tests</Button>
            <p>Saved tests bind to the saved decision version. Load cases before saving to detect concurrent edits. Unsaved editor changes are only used by Evaluate Independent Scenarios.</p>
          </div>}
        </Tile>
        {mode === 'batch' && <Tile className="decisions-mt-06">
          <h4>KPI impact simulation</h4>
          <p>Run the scenarios above with your own report metrics. Expressions use input and result (for example, result.approved == true). Count and rate require booleans; sum, avg, min and max require numbers. Rate is a percentage. Optional where filters must return booleans.</p>
          <TextArea id="simulation-kpi-config" labelText="Report configuration (JSON)" rows={12} value={kpiConfigJson}
            onChange={event => { invalidateKpis(); setKpiConfigJson(event.target.value); }} />
          <Select id="simulation-kpi-baseline" labelText="Compare with saved baseline (optional)" value={baselineKey}
            onChange={event => { invalidateKpis(); setBaselineKey(event.target.value); }}>
            <SelectItem value="" text="No baseline comparison" />
            {Object.entries(models).filter(([, model]) => model.id && model.version).map(([key, model]) =>
              <SelectItem key={key} value={key} text={`${model.name} — saved version ${model.version}`} />)}
          </Select>
          <div className="decisions-gap-03 decisions-mt-05" style={{ display: 'flex', flexWrap: 'wrap' }}>
            <Button kind="secondary" disabled={!backendConnected || batchBusy || !!csvRows} onClick={runKpis}>Run KPI simulation</Button>
            <Button kind="tertiary" onClick={() => {
              try { downloadJson(JSON.parse(kpiConfigJson), 'simulation-report-config.json'); }
              catch (error) { setBatchError(error.message); }
            }}>Download configuration</Button>
          </div>
          <p>KPI simulation does not record a saved regression-suite pass. Compare saved baselines with the current draft to assess proposed changes.</p>
        </Tile>}
      </Column>

      {/* Right Column: Execution Output & Tracing */}
      <Column lg={9} md={8} sm={4}>
        {mode === 'batch' && kpiResult && <Tile className="decisions-mb-06">
          <h4>{kpiResult.title}</h4>
          <p>{kpiResult.summary.successfulScenarios} successful scenarios; {kpiResult.summary.failedScenarios} execution errors. Metrics exclude failed executions and report their own expression errors. Empty samples are unavailable.</p>
          <Table size="sm"><TableHead><TableRow>
            <TableHeader>KPI</TableHeader><TableHeader>Value</TableHeader><TableHeader>Samples</TableHeader><TableHeader>Excluded</TableHeader><TableHeader>Errors</TableHeader><TableHeader>Status</TableHeader>
          </TableRow></TableHead><TableBody>
            {kpiResult.metrics.map(metric => <TableRow key={metric.name}>
              <TableCell>{metric.name} ({metric.aggregation})</TableCell>
              <TableCell>{metric.value === null ? 'Unavailable' : `${metric.value}${metric.unit === 'percent' ? '%' : ''}`}</TableCell>
              <TableCell>{metric.sampleCount}</TableCell><TableCell>{metric.excludedCount}</TableCell>
              <TableCell>{metric.errorCount}</TableCell><TableCell>{metric.status}</TableCell>
            </TableRow>)}
          </TableBody></Table>
          {kpiResult.comparison && <>
            <h5>Saved baseline comparison</h5>
            <p>Baseline version {kpiResult.baseline.decisionVersion}; {kpiResult.baseline.summary.failedScenarios} baseline execution errors. Deltas are current minus baseline. Partial results are marked for review.</p>
            <Table size="sm"><TableHead><TableRow><TableHeader>KPI</TableHeader><TableHeader>Baseline</TableHeader><TableHeader>Current</TableHeader><TableHeader>Delta</TableHeader><TableHeader>Comparison</TableHeader></TableRow></TableHead><TableBody>
              {kpiResult.comparison.map(metric => <TableRow key={metric.name}><TableCell>{metric.name}</TableCell>
                <TableCell>{metric.baseline ?? 'Unavailable'}</TableCell><TableCell>{metric.current ?? 'Unavailable'}</TableCell>
                <TableCell>{metric.delta === null ? 'Unavailable' : `${metric.delta} ${metric.unit}`}</TableCell>
                <TableCell>{metric.comparable ? 'Complete, matching scenarios' : 'Review missing or partial samples'}</TableCell>
              </TableRow>)}
            </TableBody></Table>
          </>}
          <Button className="decisions-mt-05" kind="tertiary" onClick={() => downloadJson(kpiResult, 'simulation-impact-report.json')}>Download impact report</Button>
        </Tile>}
        {mode === 'batch' && <Tile className="decisions-mb-06">
          <h4>Batch scenario results</h4>
          {!batchResult ? <p>Run independent scenarios or a saved test suite. Results clear when the decision changes.</p> : <>
            <p>{batchResult.savedSuite ? `Saved suite revision ${batchResult.suiteRevision}, decision version ${batchResult.decisionVersion}.` : 'Ad hoc batch results; this does not record a saved regression-suite pass.'}</p>
            <Table size="sm"><TableHead><TableRow><TableHeader>Scenario</TableHeader><TableHeader>Comparison</TableHeader><TableHeader>Expected</TableHeader><TableHeader>Actual</TableHeader></TableRow></TableHead><TableBody>
              {batchResult.results.map((result, index) => <TableRow key={index}><TableCell>{result.name}</TableCell><TableCell><Tag type={result.passed === true ? 'green' : result.passed === false ? 'red' : 'gray'}>{result.passed === true ? 'Passed' : result.passed === false ? 'Failed' : 'No expectation'}</Tag>{result.error && <p>{result.error}</p>}</TableCell><TableCell><pre>{result.expected === undefined ? 'Not specified' : JSON.stringify(result.expected, null, 2)}</pre></TableCell><TableCell><pre>{JSON.stringify(result.actual, null, 2)}</pre></TableCell></TableRow>)}
            </TableBody></Table>
          </>}
        </Tile>}
        {mode === 'single' && <>
        {/* Performance Statistics Bar */}
        {evaluationResult?.performance && (
          <div className="decisions-stats-bar">
            <div className="decisions-stat-card">
              <div className="stat-label">Execution Time</div>
              <div className="stat-value">{evaluationResult.performance.durationMicros} μs</div>
              <div className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>
                ({evaluationResult.performance.durationMillis} ms)
              </div>
            </div>
            <div className="decisions-stat-card">
              <div className="stat-label">Nodes Processed</div>
              <div className="stat-value">{evaluationResult.performance.nodesExecuted}</div>
              <div className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>DAG traversal complete</div>
            </div>
            <div className="decisions-stat-card">
              <div className="stat-label">Engine Backend</div>
              <div className="stat-value decisions-type-heading-03" >
                Decision service
              </div>
              <div className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>
                Server-side simulation
              </div>
            </div>
          </div>
        )}

        {/* Result Output */}
        <Tile className="decisions-mb-06" >
          <h4 className="decisions-type-heading-02 decisions-mb-04" >Decision Result</h4>
          {evaluationResult && Object.hasOwn(evaluationResult, 'result') ? (
            <CodeSnippet type="multi" feedback="Copied to clipboard">
              {JSON.stringify(evaluationResult.result, null, 2)}
            </CodeSnippet>
          ) : (
            <div className="decisions-p-07-05" style={{ textAlign: 'center', color: 'var(--cds-text-secondary)' }}>
              Click <strong>Evaluate Decision</strong> to execute the rules model.
            </div>
          )}
        </Tile>

        {/* Execution Trace Tree */}
        {evaluationResult?.trace && evaluationResult.trace.length > 0 && (
          <Tile>
            <h4 className="decisions-type-heading-02 decisions-mb-04" >Execution Trace (Audit Log)</h4>
            <p className="decisions-type-body-compact-01 decisions-mb-05" style={{ color: 'var(--cds-text-secondary)' }}>
              Step-by-step telemetry of node execution order, condition evaluations, and microsecond latencies.
            </p>

            <Accordion>
              {evaluationResult.trace.map((nodeTrace, idx) => (
                <AccordionItem
                  key={nodeTrace.id || idx}
                  title={
                    <div className="decisions-gap-04" style={{ display: 'flex', alignItems: 'center' }}>
                      <Tag type={nodeTrace.status === 'success' ? 'green' : 'red'} size="sm">
                        {nodeTrace.type}
                      </Tag>
                      <span className="decisions-type-heading-01" >{nodeTrace.name}</span>
                      <span className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>
                        ({nodeTrace.durationMicros} μs)
                      </span>
                    </div>
                  }
                  open={idx === 1} // Open decision table trace by default
                >
                  {/* If decision table, show rule trace details */}
                  {nodeTrace.ruleTrace && (
                    <div className="decisions-mb-05" >
                      <div className="decisions-type-label-01 decisions-mb-03" style={{ color: 'var(--cds-text-secondary)' }}>
                        EVALUATED RULES:
                      </div>
                      {nodeTrace.ruleTrace.map((r, rIdx) => (
                        <div
                          key={r.ruleId || rIdx}
                          className="decisions-p-04 decisions-mb-03" style={{ borderRadius: '4px', border: '1px solid var(--cds-border-subtle-01)', backgroundColor: r.passed ? 'var(--cds-layer-02)' : 'var(--cds-layer-01)' }}
                        >
                          <div className="decisions-mb-03" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'center' }}>
                              {r.passed ? (
                                <CheckmarkFilled style={{ color: 'var(--cds-support-success)' }} />
                              ) : (
                                <CloseFilled style={{ color: 'var(--cds-icon-secondary)' }} />
                              )}
                              <span className="decisions-type-heading-01" >
                                Rule {r.ruleIndex + 1} ({r.ruleId})
                              </span>
                            </div>
                            <span className={`rule-match-pill ${r.passed ? 'matched' : 'unmatched'}`}>
                              {r.passed ? 'MATCHED' : 'SKIPPED'}
                            </span>
                          </div>

                          {r.description && (
                            <div className="decisions-type-label-01 decisions-mb-03" style={{ color: 'var(--cds-text-secondary)' }}>
                              {r.description}
                            </div>
                          )}

                          <div className="decisions-type-code-01" >
                            {r.conditions.map((cond, cIdx) => (
                              <div key={cIdx} style={{ color: cond.passed ? 'var(--cds-text-primary)' : 'var(--cds-text-secondary)' }}>
                                • <strong>{cond.field}</strong> [{cond.test}]: {cond.details}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="decisions-type-label-01 decisions-mb-02" style={{ color: 'var(--cds-text-secondary)' }}>
                    OUTPUT SNAPSHOT:
                  </div>
                  <CodeSnippet type="multi" maxCollapsedNumberOfRows={4}>
                    {JSON.stringify(nodeTrace.outputSnapshot, null, 2)}
                  </CodeSnippet>
                </AccordionItem>
              ))}
            </Accordion>
          </Tile>
        )}
        </>}
      </Column>
    </Grid>
  );
}
