import React, { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../config.js';
import {
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableContainer,
  Button,
  Tag,
  Tile,
  Modal,
  TextInput,
  Select,
  SelectItem,
  CodeSnippet,
  InlineNotification
} from '@carbon/react';
import { Add, TrashCan, Play, DocumentView, Analytics, Bot, ArrowUp, ArrowDown } from '@carbon/icons-react';
import AddWatsonxBoxModal from './AddWatsonxBoxModal.jsx';

export default function DecisionTableTab({ model, onUpdateModel, onEvaluate, onSaveToDb, evaluationResult, editable = true }) {
  const [selectedTableId, setSelectedTableId] = useState('');
  const [requestError, setRequestError] = useState('');
  const signature = JSON.stringify([model?.id, model?.version, model?._dirty, model?.graph]);
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  const requestEpoch = useRef(0);
  useEffect(() => {
    requestEpoch.current += 1;
    setDiagnostics(null); setHeatmapData(null); setShowHeatmap(false);
    setRequestError(''); setIsCheckingDiagnostics(false); setIsLoadingHeatmap(false);
    setIsAddModalOpen(false); setIsWatsonxModalOpen(false);
  }, [signature, editable]);
  const historical = value => Number.isFinite(value) ? value : 'Unavailable';
  const heatFor = id => {
    const heat = heatmapData?.ruleHeatmap?.[id];
    return heat && Number.isFinite(heat.hitCount) && Number.isFinite(heat.hitPercentage) ? heat : null;
  };
  // State for adding a new rule
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newRuleDesc, setNewRuleDesc] = useState('');
  const [newRuleInputs, setNewRuleInputs] = useState({});
  const [newRuleOutputs, setNewRuleOutputs] = useState({});
  const [diagnostics, setDiagnostics] = useState(null);
  const [isCheckingDiagnostics, setIsCheckingDiagnostics] = useState(false);

  // Enterprise Features: Heatmap & Declarative Policy
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapData, setHeatmapData] = useState(null);
  const [isLoadingHeatmap, setIsLoadingHeatmap] = useState(false);
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);

  // watsonx Box Integration State
  const [isWatsonxModalOpen, setIsWatsonxModalOpen] = useState(false);
  const [editingWatsonxNode, setEditingWatsonxNode] = useState(null);


  if (!model) return null;

  // Find decisionTableNode
  const tableNodes = (model.graph?.nodes || []).filter(n => n.type === 'decisionTableNode');
  const tableNodeIndex = (model.graph?.nodes || []).findIndex(n => n.id === (tableNodes.find(n => n.id === selectedTableId)?.id || tableNodes[0]?.id));
  const tableNode = model.graph?.nodes?.[tableNodeIndex];

  if (!tableNode || !tableNode.content) {
    return (
      <Tile className="decisions-mt-06" >
        <p>No Decision Table node found in this model.</p>
      </Tile>
    );
  }

  const { hitPolicy = 'first', inputs = [], outputs = [], rules = [] } = tableNode.content;

  const watsonxNodes = (model.graph?.nodes || []).filter(
    (n) => n.type === 'watsonxAiNode' || n.type === 'watsonxMlNode'
  );

  const handleDeleteWatsonxNode = (nodeId) => {
    if (!editable) return;
    const updatedModel = JSON.parse(JSON.stringify(model));
    updatedModel.graph.nodes = (updatedModel.graph.nodes || []).filter((n) => n.id !== nodeId);
    updatedModel.graph.edges = (updatedModel.graph.edges || []).filter(
      (e) => e.sourceId !== nodeId && e.targetId !== nodeId
    );
    onUpdateModel(updatedModel);
  };

  const toggleHeatmap = async () => {
    if (showHeatmap) { setShowHeatmap(false); return; }
    if (model._dirty || !model.version) { setRequestError('Save this draft before loading historical analytics.'); return; }
    const key = signature, epoch = ++requestEpoch.current;
    setIsLoadingHeatmap(true); setHeatmapData(null); setRequestError('');
    try {
      const res = await fetch(`${API_BASE}/api/decisions/models/${encodeURIComponent(model.id)}/analytics`);
      if (!res.ok) throw new Error(`Analytics unavailable (HTTP ${res.status}).`);
      const data = await res.json();
      if (!data || !data.ruleHeatmap || typeof data.ruleHeatmap !== 'object') throw new Error('Analytics unavailable: the service returned no rule frequencies.');
      if (currentSignature.current === key && requestEpoch.current === epoch) { setHeatmapData(data); setShowHeatmap(true); }
    } catch (error) {
      if (currentSignature.current === key && requestEpoch.current === epoch) { setRequestError(error.message); setShowHeatmap(false); }
    } finally { if (currentSignature.current === key && requestEpoch.current === epoch) setIsLoadingHeatmap(false); }
  };

  const handleRunDiagnostics = async () => {
    const key = signature, epoch = ++requestEpoch.current;
    setIsCheckingDiagnostics(true); setDiagnostics(null); setRequestError('');
    try {
      const res = await fetch(`${API_BASE}/api/decisions/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: model.graph || model })
      });
      if (!res.ok) throw new Error(`Static analysis unavailable (HTTP ${res.status}).`);
      const data = await res.json();
      if (!Array.isArray(data?.diagnostics)) throw new Error('Static analysis returned an invalid response.');
      if (currentSignature.current === key && requestEpoch.current === epoch) setDiagnostics(data.diagnostics);
    } catch (error) {
      if (currentSignature.current === key && requestEpoch.current === epoch) setRequestError(error.message);
    } finally { if (currentSignature.current === key && requestEpoch.current === epoch) setIsCheckingDiagnostics(false); }
  };

  // Check matched rule IDs from evaluation trace
  const matchedRuleIds = new Set();
  const tableTrace = evaluationResult?.trace?.find((t) => t.id === tableNode.id);
  if (tableTrace?.ruleTrace) {
    tableTrace.ruleTrace.forEach((r) => {
      if (r.passed) matchedRuleIds.add(r.ruleId);
    });
  }

  const handleCellChange = (ruleIndex, key, value) => {
    if (!editable) return;
    const updatedRules = [...rules];
    updatedRules[ruleIndex] = {
      ...updatedRules[ruleIndex],
      [key]: value
    };

    const updatedModel = JSON.parse(JSON.stringify(model));
    updatedModel.graph.nodes[tableNodeIndex].content.rules = updatedRules;
    onUpdateModel(updatedModel);
  };

  const handleDeleteRule = (ruleIndex) => {
    if (!editable) return;
    const updatedRules = rules.filter((_, idx) => idx !== ruleIndex);
    const updatedModel = JSON.parse(JSON.stringify(model));
    updatedModel.graph.nodes[tableNodeIndex].content.rules = updatedRules;
    onUpdateModel(updatedModel);
  };

  const handleHitPolicyChange = (newPolicy) => {
    if (!editable) return;
    const updatedModel = JSON.parse(JSON.stringify(model));
    updatedModel.graph.nodes[tableNodeIndex].content.hitPolicy = newPolicy;
    onUpdateModel(updatedModel);
  };

  const handleAddRule = () => {
    if (!editable) return;
    const newRule = {
      _id: `rule_${crypto.randomUUID()}`,
      _description: newRuleDesc || `Custom Rule ${rules.length + 1}`,
      ...newRuleInputs,
      ...newRuleOutputs
    };

    const updatedModel = JSON.parse(JSON.stringify(model));
    updatedModel.graph.nodes[tableNodeIndex].content.rules = [...rules, newRule];
    onUpdateModel(updatedModel);
    setIsAddModalOpen(false);
    setNewRuleDesc('');
    setNewRuleInputs({});
    setNewRuleOutputs({});
  };

  const handleMoveRule = (index, offset) => {
    if (!editable || index + offset < 0 || index + offset >= rules.length) return;
    const updatedModel = structuredClone(model);
    const reordered = updatedModel.graph.nodes[tableNodeIndex].content.rules;
    [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
    onUpdateModel(updatedModel);
  };

  // Human-readable table summary; not an executable policy format
  const generatePolicyText = () => {
    let out = `# ========================================================\n`;
    out += `# DecisionsBuddy Human-readable Table Summary\n`;
    out += `# Decision: ${model.name || model.id}\n`;
    out += `# Hit Policy: ${hitPolicy.toUpperCase()}\n`;
    out += `# ========================================================\n\n`;

    out += `inputs:\n`;
    inputs.forEach((i) => {
      out += `  - field: "${i.field}" as "${i.name || i.field}"\n`;
    });

    out += `\noutputs:\n`;
    outputs.forEach((o) => {
      out += `  - field: "${o.field}" as "${o.name || o.field}"\n`;
    });

    out += `\nrules:\n`;
    rules.forEach((r, idx) => {
      out += `  - [Rule ${idx + 1}] "${r._description || 'Rule ' + (idx + 1)}"\n`;
      inputs.forEach((i) => {
        out += `      when ${i.field} is ${r[i.id] || '-'}\n`;
      });
      outputs.forEach((o) => {
        out += `      then ${o.field} = ${JSON.stringify(r[o.id] !== undefined ? r[o.id] : '-')}\n`;
      });
    });

    return out;
  };

  const headers = [
    { key: 'ruleNum', header: '#' },
    { key: 'description', header: 'Rule Description' },
    ...(showHeatmap ? [{ key: 'heatmap', header: '🔥 Execution Frequency' }] : []),
    ...inputs.map((inp) => ({ key: inp.id, header: `IN: ${inp.name || inp.field}` })),
    ...outputs.map((out) => ({ key: out.id, header: `OUT: ${out.name || out.field}` })),
    { key: 'actions', header: 'Actions' }
  ];

  const rows = rules.map((r, idx) => {
    const rowObj = {
      id: r._id || `rule_${idx + 1}`,
      ruleNum: idx + 1,
      description: r._description || `Rule ${idx + 1}`
    };

    if (showHeatmap) {
      const heat = heatFor(r._id);
      rowObj.heatmap = heat ? `${heat.hitCount} hits (${heat.hitPercentage}%)` : 'Unavailable';
    }

    inputs.forEach((inp) => {
      rowObj[inp.id] = String(r[inp.id] ?? '-');
    });
    outputs.forEach((out) => {
      rowObj[out.id] = String(r[out.id] ?? '-');
    });
    return rowObj;
  });

  return (
    <div className="decisions-mt-06" >
      {requestError && <InlineNotification kind="error" lowContrast title="Request failed" subtitle={requestError} onCloseButtonClick={() => setRequestError('')} />}
      <Select id="decision-table-select" labelText="Decision table" value={tableNode.id} onChange={event => setSelectedTableId(event.target.value)}>
        {tableNodes.map(node => <SelectItem key={node.id} value={node.id} text={node.name || node.id} />)}
      </Select>
      {!editable && <p>Read-only decision. Rule editing and reordering require edit access.</p>}
      <p>{hitPolicy === 'first' ? 'FIRST policy: rows are evaluated in priority order; the first matching row wins.' : hitPolicy === 'ruleOrder' ? 'RULE ORDER policy: all matching rows fire and return in their defined order.' : 'COLLECT policy: all matching rows contribute in the displayed order.'}</p>
      <Tile className="decisions-mb-05 decisions-gap-05" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <h4 className="decisions-type-heading-02 decisions-m-00" >{tableNode.name}</h4>
          <p className="decisions-type-body-compact-01 decisions-m-02-00-00-00" style={{ color: 'var(--cds-text-secondary)' }}>
            Interactive Decision Table: Edit conditions & output expressions directly in the grid.
          </p>
        </div>
        <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            id="hit-policy-select"
            labelText=""
            hideLabel
            size="sm"
            value={hitPolicy}
            disabled={!editable}
            onChange={(e) => handleHitPolicyChange(e.target.value)}
          >
            <SelectItem value="first" text="Hit Policy: FIRST" />
            <SelectItem value="collect" text="Hit Policy: COLLECT" />
            <SelectItem value="ruleOrder" text="Hit Policy: RULE ORDER" />
          </Select>

          <Button
            size="sm"
            kind={showHeatmap ? 'primary' : 'tertiary'}
            renderIcon={Analytics}
            onClick={toggleHeatmap}
            disabled={isLoadingHeatmap || isCheckingDiagnostics || model._dirty || !model.version}
          >
            {showHeatmap ? 'Hide Heatmap' : '🔥 Rule Heatmap'}
          </Button>

          <Button
            size="sm"
            kind="ghost"
            renderIcon={DocumentView}
            onClick={() => setIsPolicyModalOpen(true)}
          >
            .policy View
          </Button>

          <Button
            size="sm"
            kind="tertiary"
            renderIcon={Add}
            onClick={() => setIsAddModalOpen(true)}
            disabled={!editable}
          >
            Add Rule
          </Button>
          <Button
            size="sm"
            kind="tertiary"
            renderIcon={Bot}
            disabled={!editable}
            onClick={() => {
              setEditingWatsonxNode(null);
              setIsWatsonxModalOpen(true);
            }}
          >
            + watsonx Box
          </Button>
          <Button
            size="sm"
            kind="ghost"
            onClick={handleRunDiagnostics}
            disabled={isCheckingDiagnostics || isLoadingHeatmap}
          >
            Check Rule Conflicts
          </Button>
          <Button
            size="sm"
            kind="secondary"
            disabled={!editable || !onSaveToDb}
            onClick={() => editable && onSaveToDb && onSaveToDb(model)}
          >
            Save decision
          </Button>
          <Button
            size="sm"
            kind="primary"
            renderIcon={Play}
            onClick={onEvaluate}
          >
            Re-evaluate
          </Button>
        </div>
      </Tile>

      {/* watsonx Decision Intelligence Section */}
      <Tile className="decisions-mb-05 decisions-p-04-05" style={{ borderLeft: '4px solid var(--cds-support-info, #0f62fe)' }}>
        <div className="decisions-gap-04" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'center' }}>
              <Bot size={20} />
              <h5 className="decisions-type-heading-02 decisions-m-00">watsonx Decision Intelligence</h5>
              <Tag type="purple" size="sm">watsonx.ai & watsonx ML</Tag>
            </div>
            <p className="decisions-type-label-01 decisions-m-02-00-00-00" style={{ color: 'var(--cds-text-secondary)' }}>
              Incorporate generative AI recommendations or predictive machine learning scores directly into this decision logic.
            </p>
          </div>

          <Button
            size="sm"
            kind="tertiary"
            renderIcon={Bot}
            disabled={!editable}
            onClick={() => {
              setEditingWatsonxNode(null);
              setIsWatsonxModalOpen(true);
            }}
          >
            + Add watsonx Box to Decision
          </Button>
        </div>

        {watsonxNodes.length > 0 ? (
          <div className="decisions-mt-03 decisions-gap-03" style={{ display: 'flex', flexWrap: 'wrap' }}>
            {watsonxNodes.map((wNode) => {
              const isAi = wNode.type === 'watsonxAiNode';
              const content = wNode.content || {};
              const targetField = isAi ? (content.outputField || 'aiRecommendation') : (content.outputField || 'mlScore');
              const modelDesc = isAi ? (content.modelId || 'granite-13b') : (content.deploymentId || 'ML deployment');
              const endpoint = content.endpoint || 'watsonx SaaS / CP4D';
              return (
                <div
                  key={wNode.id}
                  className="decisions-p-03-04 decisions-gap-03"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    backgroundColor: 'var(--cds-layer-02)',
                    borderRadius: '4px',
                    border: '1px solid var(--cds-border-subtle)'
                  }}
                >
                  <Tag type={isAi ? 'purple' : 'cyan'} size="sm">
                    {isAi ? 'watsonx.ai' : 'watsonx ML'}
                  </Tag>
                  <div>
                    <strong className="decisions-type-body-compact-01">{wNode.name || wNode.id}</strong>
                    <div className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>
                      Outputs: <code>{targetField}</code> | Model: {modelDesc} | {endpoint}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    kind="ghost"
                    disabled={!editable}
                    onClick={() => {
                      setEditingWatsonxNode(wNode);
                      setIsWatsonxModalOpen(true);
                    }}
                  >
                    Configure
                  </Button>
                  <Button
                    hasIconOnly
                    size="sm"
                    kind="ghost"
                    renderIcon={TrashCan}
                    iconDescription="Remove watsonx Box"
                    onClick={() => handleDeleteWatsonxNode(wNode.id)}
                    disabled={!editable}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="decisions-mt-03 decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>
            No watsonx AI / ML box added yet. Click <strong>+ Add watsonx Box to Decision</strong> to connect your watsonx endpoint and automatically bind model predictions into this decision table.
          </div>
        )}
      </Tile>

      {/* Heatmap Telemetry Banner */}
      {showHeatmap && heatmapData && (
        <Tile className="decisions-mb-05 decisions-gap-05" style={{ borderLeft: '4px solid #f1c21b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h5 className="decisions-type-heading-02 decisions-m-00" >🔥 Rule Execution Heatmap Active</h5>
            <p className="decisions-type-label-01 decisions-m-02-00-00-00" style={{ color: 'var(--cds-text-secondary)' }}>
              Historical hit frequency across saved versions, computed from available audit traces. Missing row measurements are unavailable; this is not a measurement of the current draft.
            </p>
          </div>
          <div className="decisions-gap-06" style={{ display: 'flex', alignItems: 'center' }}>
            <div>
              <span className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>TOTAL RUNS: </span>
              <strong className="decisions-type-body-compact-01" >{historical(heatmapData.totalRuns)}</strong>
            </div>
            <div>
              <span className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>AVG LATENCY: </span>
              <strong className="decisions-type-body-compact-01" >{historical(heatmapData.avgLatencyMicros)} µs</strong>
            </div>
            <div>
              <span className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>P95 LATENCY: </span>
              <strong className="decisions-type-body-compact-01" >{historical(heatmapData.p95LatencyMicros)} µs</strong>
            </div>
          </div>
        </Tile>
      )}

      {/* Static Analysis & Rule Conflict Banner */}
      {diagnostics && (
        <Tile className="decisions-mb-05" style={{ borderLeft: diagnostics.length > 0 ? '4px solid var(--cds-support-warning, #f1c21b)' : '4px solid var(--cds-support-success, #24a148)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h5 className="decisions-type-heading-02 decisions-m-00" >
              {diagnostics.length === 0 ? '✓ Static Analysis Passed: No Rule Conflicts or Shadowed Rules Detected' : `Rule Diagnostic: Found ${diagnostics.length} Issue(s)`}
            </h5>
            <Button size="sm" kind="ghost" onClick={() => setDiagnostics(null)}>Dismiss</Button>
          </div>
          {diagnostics.map((d, dIdx) => (
            <div key={dIdx} className="decisions-type-body-compact-01 decisions-mt-03 decisions-gap-03" style={{ display: 'flex', alignItems: 'center' }}>
              <Tag type={d.severity === 'error' ? 'red' : d.severity === 'warning' ? 'yellow' : 'blue'} size="sm">
                {d.code}
              </Tag>
              <span>{d.message}</span>
            </div>
          ))}
        </Tile>
      )}

      <DataTable rows={rows} headers={headers}>
        {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer
            title="Interactive Rule Table"
            description="Double-click or edit conditions & output values directly in the grid. Changes update in real-time."
            style={{ width: '100%', overflowX: 'auto', backgroundColor: 'var(--cds-layer-01)', borderRadius: '4px' }}
          >
            <Table size="lg" {...getTableProps()} style={{ width: '100%', minWidth: '950px' }}>
              <TableHead>
                <TableRow>
                  {headers.map((header) => (
                    <TableHeader
                      key={header.key}
                      {...getHeaderProps({ header })}
                      className="decisions-type-heading-01 decisions-p-04-05" style={{ whiteSpace: 'nowrap', backgroundColor: 'var(--cds-layer-02)' }}
                    >
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, rIdx) => {
                  const isMatched = matchedRuleIds.has(row.id);
                  const heat = heatFor(rules[rIdx]?._id);

                  return (
                    <TableRow
                      key={row.id}
                      {...getRowProps({ row })}
                      style={{
                        backgroundColor: isMatched ? 'rgba(36, 161, 72, 0.12)' : undefined,
                        borderLeft: isMatched ? '4px solid var(--cds-support-success)' : '4px solid transparent'
                      }}
                    >
                      {row.cells.map((cell) => {
                        if (cell.info.header === 'ruleNum') {
                          return (
                            <TableCell key={cell.id} className="decisions-p-03-05" >
                              <span className="decisions-gap-03" style={{ display: 'flex', alignItems: 'center' }}>
                                <strong className="decisions-type-code-01" >{cell.value}</strong>
                                {isMatched && (
                                  <Tag type="green" size="sm">
                                    MATCH
                                  </Tag>
                                )}
                              </span>
                            </TableCell>
                          );
                        }
                        if (cell.info.header === 'heatmap') {
                          return (
                            <TableCell key={cell.id} className="decisions-p-03-05" >
                              <Tag
                                type={heat?.hitPercentage >= 50 ? 'green' : heat?.hitCount > 0 ? 'teal' : 'cool-gray'}
                                size="sm"
                              >
                                {cell.value}
                              </Tag>
                            </TableCell>
                          );
                        }
                        if (cell.info.header === 'actions') {
                          return (
                            <TableCell key={cell.id} className="decisions-p-03-05" style={{ width: '60px' }}>
                              <Button hasIconOnly kind="ghost" size="sm" renderIcon={ArrowUp} iconDescription={`Move rule ${rIdx + 1} up`} disabled={!editable || rIdx === 0} onClick={() => handleMoveRule(rIdx, -1)} />
                              <Button hasIconOnly kind="ghost" size="sm" renderIcon={ArrowDown} iconDescription={`Move rule ${rIdx + 1} down`} disabled={!editable || rIdx === rules.length - 1} onClick={() => handleMoveRule(rIdx, 1)} />
                              <Button
                                hasIconOnly
                                kind="ghost"
                                size="sm"
                                renderIcon={TrashCan}
                                iconDescription="Delete Rule"
                                onClick={() => handleDeleteRule(rIdx)}
                                disabled={!editable}
                              />
                            </TableCell>
                          );
                        }
                        if (cell.info.header === 'description') {
                          return (
                            <TableCell key={cell.id} className="decisions-p-03-05" style={{ minWidth: '280px' }}>
                              <input
                                type="text"
                                readOnly={!editable}
                                aria-label={`Rule ${rIdx + 1} description`}
                                value={rules[rIdx]?._description || ''}
                                onChange={(e) => handleCellChange(rIdx, '_description', e.target.value)}
                                className="decisions-type-body-compact-01 decisions-p-03-03" style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed var(--cds-border-subtle, #c6c6c6)', color: 'var(--cds-text-primary)', width: '100%' }}
                              />
                            </TableCell>
                          );
                        }

                        // Input or Output column
                        const colKey = cell.info.header;
                        return (
                          <TableCell key={cell.id} className="decisions-p-03-04" style={{ minWidth: '130px' }}>
                            <input
                              type="text"
                              readOnly={!editable}
                              aria-label={`Rule ${rIdx + 1} ${colKey}`}
                              value={rules[rIdx]?.[colKey] ?? ''}
                              onChange={(e) => handleCellChange(rIdx, colKey, e.target.value)}
                              className="decisions-table-input-cell"
                            />
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>


      {/* Add Rule Modal */}
      <Modal
        open={isAddModalOpen}
        onRequestClose={() => setIsAddModalOpen(false)}
        onRequestSubmit={handleAddRule}
        primaryButtonDisabled={!editable}
        modalHeading="Add Decision Rule"
        primaryButtonText="Add Rule"
        secondaryButtonText="Cancel"
      >
        <div className="decisions-gap-05 decisions-mt-05" style={{ display: 'flex', flexDirection: 'column' }}>
          <TextInput
            id="rule-desc"
            labelText="Rule Description"
            placeholder="e.g. Bronze Customers get 5% discount"
            value={newRuleDesc}
            onChange={(e) => setNewRuleDesc(e.target.value)}
          />

          <div>
            <h5 className="decisions-type-heading-02 decisions-mb-03" >Input Unary Conditions</h5>
            <div className="decisions-gap-03" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              {inputs.map((inp) => (
                <TextInput
                  key={inp.id}
                  id={`inp-${inp.id}`}
                  labelText={`${inp.name || inp.field} (${inp.field})`}
                  placeholder="e.g. >= 100, in ['US','CA']"
                  value={newRuleInputs[inp.id] || ''}
                  onChange={(e) =>
                    setNewRuleInputs({ ...newRuleInputs, [inp.id]: e.target.value })
                  }
                />
              ))}
            </div>
          </div>

          <div>
            <h5 className="decisions-type-heading-02 decisions-mb-03" >Output Assignments</h5>
            <div className="decisions-gap-03" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              {outputs.map((out) => (
                <TextInput
                  key={out.id}
                  id={`out-${out.id}`}
                  labelText={`${out.name || out.field} (${out.field})`}
                  placeholder="e.g. 15, true, 'ACCEPTED'"
                  value={newRuleOutputs[out.id] || ''}
                  onChange={(e) =>
                    setNewRuleOutputs({ ...newRuleOutputs, [out.id]: e.target.value })
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Declarative .policy Document Modal */}
      <Modal
        open={isPolicyModalOpen}
        onRequestClose={() => setIsPolicyModalOpen(false)}
        modalHeading="DecisionsBuddy Human-readable Table Summary (.policy)"
        passiveModal
        size="lg"
      >
        <div className="decisions-gap-05" style={{ display: 'flex', flexDirection: 'column' }}>
          <p className="decisions-type-body-compact-01 decisions-m-00" style={{ color: 'var(--cds-text-secondary)' }}>
            Text-based human-readable specification of this decision table. Can be saved as a <code>.policy</code> file or committed to version control.
          </p>
          <CodeSnippet type="multi" feedback="Copied to clipboard">
            {generatePolicyText()}
          </CodeSnippet>
        </div>
      </Modal>

      {/* Add / Edit watsonx Box Modal */}
      <AddWatsonxBoxModal
        isOpen={isWatsonxModalOpen}
        editable={editable}
        onClose={() => {
          setIsWatsonxModalOpen(false);
          setEditingWatsonxNode(null);
        }}
        model={model}
        onUpdateModel={updated => { if (editable) onUpdateModel(updated); }}
        existingNode={editingWatsonxNode}
      />
    </div>
  );
}
