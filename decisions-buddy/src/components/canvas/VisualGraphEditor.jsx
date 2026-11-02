import { themeCssValue } from '../../../../web/src/lib/themeColor.ts';
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesInitialized,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  Button,
  Tag,
  Tile,
  Modal,
  TextInput,
  TextArea,
  Select,
  SelectItem,
  Table,
  InlineNotification,
  CodeSnippet
} from '@carbon/react';
import { Add, Play, Reset, Flow, DecisionTree, Code, TrashCan, ZoomIn, Bot, Analytics } from '@carbon/icons-react';
import CustomNode from './CustomNode.jsx';
import ModernNodeEditor from './ModernNodeEditor.jsx';
import { MODERN_TYPES, modernNodeDefaults, modernNodeDraft, normalizeModernDraft } from '../../lib/modernNodes.js';
import { apiRequest } from '../../config.js';
import AddWatsonxBoxModal from '../AddWatsonxBoxModal.jsx';

const nodeTypes = {
  custom: CustomNode
};

function FitVisibleFlow({ active, wrapper, graph }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    const element = wrapper.current;
    if (!active || !initialized || !element) return;
    let frame;
    let timer;
    const fit = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          const { width, height } = element.getBoundingClientRect();
          if (width > 0 && height > 0) {
            void fitView({ padding: 0.2, minZoom: 0.01, maxZoom: 1.2,
              duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250 });
          }
        }, 30);
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [active, initialized, fitView, wrapper, graph]);
  return null;
}

export default function VisualGraphEditor({
  model,
  onSaveGraph,
  onEvaluate,
  onSaveAndRun,
  evaluationResult,
  isBusy = false,
  onShowResults,
  onOpenBobDesigner,
  active = true,
  editable = false
}) {
  const reactFlowWrapper = useRef(null);
  const [rfInstance, setRfInstance] = useState(null);

  const zoomToFlow = useCallback(() => {
    if (rfInstance) {
      rfInstance.fitView({ padding: 0.2, duration: 250, minZoom: 0.01, maxZoom: 1.2 });
    }
  }, [rfInstance]);



  const modelRef = useRef(model);
  const editableRef = useRef(editable);
  const onSaveGraphRef = useRef(onSaveGraph);
  const handlers = useRef({});
  const nodeToCanvas = useCallback((node, index) => ({
    id: node.id, type: 'custom', position: node.position || { x: 100 + index * 240, y: 150 },
    data: { editable, original: node, nodeType: node.type, name: node.name || node.id,
      content: node.content || {},
      summary: node.type === 'functionNode' ? 'Unsupported: executable function nodes are disabled' : node.type === 'decisionTableNode'
        ? `${node.content?.rules?.length || 0} Rules (${node.content?.hitPolicy || 'first'})` : node.type,
      onDelete: editable ? id => handlers.current.deleteNode(id) : undefined,
      onEdit: editable && node.type !== 'functionNode' ? id => handlers.current.openEdit(id) : undefined }
  }), [editable]);
  const edgeToCanvas = edge => ({ ...edge, source: edge.sourceId, target: edge.targetId,
    animated: true, style: { stroke: 'var(--cds-focus, #0f62fe)', strokeWidth: 2 },
    data: { original: edge } });
  const initialNodes = (model?.graph?.nodes || []).map(nodeToCanvas);
  const initialEdges = (model?.graph?.edges || []).map(edgeToCanvas);
  const [nodes, setCanvasNodes] = useState(initialNodes);
  const [edges, setCanvasEdges] = useState(initialEdges);
  const nodesRef = useRef(nodes), edgesRef = useRef(edges);
  const lastPublished = useRef('');
  const exportGraph = (canvasNodes = nodesRef.current, canvasEdges = edgesRef.current) => ({
    ...modelRef.current.graph,
    nodes: canvasNodes.map(node => ({ ...node.data.original, id: node.id, name: node.data.name,
      type: node.data.nodeType, position: node.position, content: node.data.content || {} })),
    edges: canvasEdges.map(edge => {
      const result = { ...edge.data?.original, id: edge.id, sourceId: edge.source, targetId: edge.target };
      for (const field of ['sourceHandle', 'targetHandle']) {
        if (Object.prototype.hasOwnProperty.call(edge, field)) result[field] = edge[field];
      }
      return result;
    })
  });
  const publish = (nextNodes, nextEdges) => {
    if (!editableRef.current) return;
    const graph = exportGraph(nextNodes, nextEdges);
    const signature = JSON.stringify(graph);
    if (signature === JSON.stringify(modelRef.current.graph)) return;
    lastPublished.current = signature;
    const updated = { ...modelRef.current, graph };
    modelRef.current = updated;
    onSaveGraphRef.current?.(updated);
  };
  const setNodes = (update, notify = true) => {
    const next = typeof update === 'function' ? update(nodesRef.current) : update;
    nodesRef.current = next; setCanvasNodes(next);
    if (notify) publish(next, edgesRef.current);
  };
  const setEdges = (update, notify = true) => {
    const next = typeof update === 'function' ? update(edgesRef.current) : update;
    edgesRef.current = next; setCanvasEdges(next);
    if (notify) publish(nodesRef.current, next);
  };

  // Dedicated Visual Node Editor Modal State
  const [editingNode, setEditingNode] = useState(null);
  const editingNodeType = editingNode?.data?.nodeType;
  const [editNodeName, setEditNodeName] = useState('');
  const [modernDraft, setModernDraft] = useState({});
  const [modernError, setModernError] = useState('');

  // watsonx Box Configuration Modal State
  const [isWatsonxBoxModalOpen, setIsWatsonxBoxModalOpen] = useState(false);
  const [watsonxBoxNode, setWatsonxBoxNode] = useState(null);
  
  // Decision Table Node state inside modal
  const [tableHitPolicy, setTableHitPolicy] = useState('first');
  const [tableInputs, setTableInputs] = useState([]);
  const [tableOutputs, setTableOutputs] = useState([]);
  const [tableRules, setTableRules] = useState([]);
  const [newColField, setNewColField] = useState('');
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState('input'); // 'input' or 'output'

  // Expression Node state inside modal
  const [expressions, setExpressions] = useState([]);
  const [newExpKey, setNewExpKey] = useState('');
  const [newExpVal, setNewExpVal] = useState('');
  const [switchStatements, setSwitchStatements] = useState([]);
  const [switchError, setSwitchError] = useState('');

  // Function Node state inside modal
  const [functionSource, setFunctionSource] = useState('');

  // watsonx.ai Node state inside modal
  const [aiEndpoint, setAiEndpoint] = useState('');
  const [aiProjectId, setAiProjectId] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModelId, setAiModelId] = useState('ibm/granite-13b-instruct-v2');
  const [aiPromptTemplate, setAiPromptTemplate] = useState('');
  const [aiOutputField, setAiOutputField] = useState('aiRecommendation');
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestFeedback, setAiTestFeedback] = useState(null);

  // watsonx ML Node state inside modal
  const [mlEndpoint, setMlEndpoint] = useState('');
  const [mlSpaceId, setMlSpaceId] = useState('');
  const [mlApiKey, setMlApiKey] = useState('');
  const [mlDeploymentId, setMlDeploymentId] = useState('deployment-churn-risk-v1');
  const [mlScoringType, setMlScoringType] = useState('classification');
  const [mlInputMapping, setMlInputMapping] = useState('{}');
  const [mlOutputField, setMlOutputField] = useState('mlScore');
  const [mlTesting, setMlTesting] = useState(false);
  const [mlTestFeedback, setMlTestFeedback] = useState(null);

  const onNodesChange = changes => {
    const permitted = editable ? changes : changes.filter(change => ['dimensions', 'select'].includes(change.type));
    setNodes(current => applyNodeChanges(permitted, current), permitted.some(change => !['dimensions', 'select'].includes(change.type)));
  };
  const onEdgesChange = changes => {
    const permitted = editable ? changes : changes.filter(change => change.type === 'select');
    setEdges(current => applyEdgeChanges(permitted, current), permitted.some(change => change.type !== 'select'));
  };
  const onConnect = params => {
    if (!editable) return;
    setEdges(current => addEdge({ ...params, id: `edge_${crypto.randomUUID()}`,
      animated: true, style: { stroke: 'var(--cds-focus, #0f62fe)', strokeWidth: 2 } }, current));
  };

  const handleDeleteNode = (id) => {
    if (!editableRef.current) return;
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
  };

  const handleOpenEdit = (id) => {
    if (!editableRef.current) return;
    const node = nodesRef.current.find((n) => n.id === id);
    if (node?.data.nodeType === 'functionNode') return;
    if (!node) return;

    if (node.data.nodeType === 'watsonxAiNode' || node.data.nodeType === 'watsonxMlNode') {
      const graphNode = (model?.graph?.nodes || []).find((n) => n.id === id) || {
        id: node.id,
        name: node.data.name,
        type: node.data.nodeType,
        content: node.data.content
      };
      setWatsonxBoxNode(graphNode);
      setIsWatsonxBoxModalOpen(true);
      return;
    }

    setEditingNode(node);
    setEditNodeName(node.data.name);
    setModernDraft(modernNodeDraft(node.data.nodeType, node.data.content || {}, modelRef.current.graph.vocabulary || []));
    setModernError('');

    if (node.data.nodeType === 'decisionTableNode') {
      const content = node.data.content || {};
      setTableHitPolicy(content.hitPolicy || 'first');
      setTableInputs(content.inputs || [{ id: 'in_1', field: 'customer.tier', name: 'Customer Tier' }]);
      setTableOutputs(content.outputs || [{ id: 'out_1', field: 'discount', name: 'Discount %' }]);
      setTableRules(content.rules || [{ _id: 'r1', _description: 'Default Rule', in_1: 'VIP', out_1: '20' }]);
    } else if (node.data.nodeType === 'switchNode') {
      setSwitchStatements(structuredClone(node.data.content?.statements || [])); setSwitchError('');
    } else if (node.data.nodeType === 'expressionNode') {
      setExpressions(node.data.content?.expressions || []);
    } else if (node.data.nodeType === 'functionNode') {
      setFunctionSource(
        typeof node.data.content === 'string'
          ? node.data.content
          : (node.data.content?.source || '')
      );
    } else if (node.data.nodeType === 'watsonxAiNode') {
      const content = node.data.content || {};
      setAiEndpoint(content.endpoint || content.baseUrl || '');
      setAiProjectId(content.projectId || content.project_id || '');
      setAiApiKey(content.apiKey || '');
      setAiModelId(content.modelId || 'ibm/granite-13b-instruct-v2');
      setAiPromptTemplate(content.promptTemplate || '');
      setAiOutputField(content.outputField || 'aiRecommendation');
      setAiTesting(false);
      setAiTestFeedback(null);
    } else if (node.data.nodeType === 'watsonxMlNode') {
      const content = node.data.content || {};
      setMlEndpoint(content.endpoint || content.baseUrl || '');
      setMlSpaceId(content.spaceId || content.space_id || '');
      setMlApiKey(content.apiKey || '');
      setMlDeploymentId(content.deploymentId || 'deployment-churn-risk-v1');
      setMlScoringType(content.scoringType || 'classification');
      setMlInputMapping(typeof content.inputMapping === 'string' ? content.inputMapping : JSON.stringify(content.inputMapping || {}, null, 2));
      setMlOutputField(content.outputField || 'mlScore');
      setMlTesting(false);
      setMlTestFeedback(null);
    }
  };

  useLayoutEffect(() => {
    modelRef.current = model; editableRef.current = editable; onSaveGraphRef.current = onSaveGraph;
    handlers.current = { deleteNode: handleDeleteNode, openEdit: handleOpenEdit };
  });
  // Parent echoes of this canvas are already rendered. Only external graph updates
  // replace the canvas, preserving selection and avoiding a draft-update loop.
  useEffect(() => {
    if (!model?.graph) return;
    const signature = JSON.stringify(model.graph);
    if (signature === lastPublished.current && nodesRef.current.every(node => node.data.editable === editable)) return;
    const nextNodes = model.graph.nodes.map(nodeToCanvas), nextEdges = model.graph.edges.map(edgeToCanvas);
    nodesRef.current = nextNodes; edgesRef.current = nextEdges;
    setCanvasNodes(nextNodes); setCanvasEdges(nextEdges);
    const fitTimer = setTimeout(() => {
      if (rfInstance) {
        rfInstance.fitView({ padding: 0.2, minZoom: 0.01, maxZoom: 1.2, duration: 250 });
      }
    }, 60);
    return () => clearTimeout(fitTimer);
  }, [model?.graph, editable, nodeToCanvas, rfInstance]);

  const handleAddColumn = () => {
    if (!newColField.trim()) return;
    const colId = `col_${crypto.randomUUID()}`;
    const newCol = {
      id: colId,
      field: newColField.trim(),
      name: newColName.trim() || newColField.trim()
    };

    if (newColType === 'input') {
      setTableInputs([...tableInputs, newCol]);
      setTableRules(tableRules.map((r) => ({ ...r, [colId]: '-' })));
    } else {
      setTableOutputs([...tableOutputs, newCol]);
      setTableRules(tableRules.map((r) => ({ ...r, [colId]: '0' })));
    }
    setNewColField('');
    setNewColName('');
  };

  const handleDeleteColumn = (colId, type) => {
    if (type === 'input') setTableInputs(current => current.filter(column => column.id !== colId));
    else setTableOutputs(current => current.filter(column => column.id !== colId));
    setTableRules(current => current.map(rule => {
      const updated = { ...rule };
      delete updated[colId];
      return updated;
    }));
  };

  const handleAddRuleRow = () => {
    const newRule = {
      _id: `r_${crypto.randomUUID()}`,
      _description: `Rule ${tableRules.length + 1}`
    };
    tableInputs.forEach((inp) => { newRule[inp.id] = '-'; });
    tableOutputs.forEach((out) => { newRule[out.id] = '0'; });
    setTableRules([...tableRules, newRule]);
  };

  const handleRuleCellChange = (rIdx, colId, value) => {
    const updated = [...tableRules];
    updated[rIdx] = { ...updated[rIdx], [colId]: value };
    setTableRules(updated);
  };

  const handleDeleteRuleRow = (rIdx) => {
    setTableRules(tableRules.filter((_, idx) => idx !== rIdx));
  };

  const handleAddExpression = () => {
    if (!newExpKey.trim() || !newExpVal.trim()) return;
    setExpressions([...expressions, { key: newExpKey.trim(), value: newExpVal.trim() }]);
    setNewExpKey('');
    setNewExpVal('');
  };

  const handleDeleteExpression = (idx) => {
    setExpressions(expressions.filter((_, i) => i !== idx));
  };

  const handleSaveModal = () => {
    if (!editingNode || !editable) return;
    let updatedContent = { ...(editingNode.data.content || {}) };
    let summary = editingNode.data.nodeType;

    if (MODERN_TYPES.includes(editingNode.data.nodeType)) {
      try { updatedContent = normalizeModernDraft(editingNode.data.nodeType, modernDraft); }
      catch (error) { setModernError(error.message); return; }
      summary = modernNodeDefaults(editingNode.data.nodeType)?.name || editingNode.data.nodeType;
    } else if (editingNode.data.nodeType === 'decisionTableNode') {
      updatedContent = {
        ...updatedContent,
        hitPolicy: tableHitPolicy,
        inputs: tableInputs,
        outputs: tableOutputs,
        rules: tableRules
      };
      summary = `${tableRules.length} Rules (${tableHitPolicy})`;
    } else if (editingNode.data.nodeType === 'expressionNode') {
      updatedContent = { ...updatedContent, expressions };
      summary = `${expressions.length} Expressions`;
    } else if (editingNode.data.nodeType === 'switchNode') {
      if (switchStatements.some(statement => !statement.id.trim()) || new Set(switchStatements.map(statement => statement.id)).size !== switchStatements.length) { setSwitchError('Branch identifiers must be unique and nonempty.'); return; }
      updatedContent = { ...updatedContent, statements: switchStatements };
      const retained = new Set(switchStatements.map(statement => statement.id));
      setEdges(current => current.filter(edge => edge.source !== editingNode.id || retained.has(edge.sourceHandle)));
      summary = `${switchStatements.length} Branches`;
    } else if (editingNode.data.nodeType === 'functionNode') {
      updatedContent = { source: functionSource };
      summary = 'Code block';
    } else if (editingNode.data.nodeType === 'watsonxAiNode') {
      updatedContent = {
        endpoint: aiEndpoint.trim(),
        projectId: aiProjectId.trim(),
        apiKey: aiApiKey.trim(),
        modelId: aiModelId.trim() || 'ibm/granite-13b-instruct-v2',
        promptTemplate: aiPromptTemplate,
        outputField: aiOutputField.trim() || 'aiRecommendation'
      };
      const host = aiEndpoint ? (() => { try { return new URL(aiEndpoint).hostname; } catch { return aiEndpoint; } })() : 'watsonx.ai';
      summary = `${aiModelId || 'granite-13b'} -> ${aiOutputField || 'aiRecommendation'} (${host})`;
    } else if (editingNode.data.nodeType === 'watsonxMlNode') {
      let mapping = {};
      try { mapping = JSON.parse(mlInputMapping); } catch {}
      updatedContent = {
        endpoint: mlEndpoint.trim(),
        spaceId: mlSpaceId.trim(),
        apiKey: mlApiKey.trim(),
        deploymentId: mlDeploymentId.trim() || 'deployment-churn-risk-v1',
        scoringType: mlScoringType,
        inputMapping: mapping,
        outputField: mlOutputField.trim() || 'mlScore'
      };
      const host = mlEndpoint ? (() => { try { return new URL(mlEndpoint).hostname; } catch { return mlEndpoint; } })() : 'watsonx ML';
      summary = `${mlDeploymentId || 'deployment'} (${mlScoringType}) -> ${mlOutputField || 'mlScore'} (${host})`;
    }

    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === editingNode.id) {
          return {
            ...n,
            data: {
              ...n.data,
              name: editNodeName,
              content: updatedContent,
              summary
            }
          };
        }
        return n;
      })
    );

    setEditingNode(null);
  };

  const handleTestAiNode = async () => {
    setAiTesting(true);
    setAiTestFeedback(null);
    try {
      const res = await apiRequest('/watsonx/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'watsonx_ai',
          endpoint: aiEndpoint.trim(),
          projectId: aiProjectId.trim(),
          apiKey: aiApiKey.trim(),
          modelId: aiModelId.trim() || 'ibm/granite-13b-instruct-v2',
          promptTemplate: aiPromptTemplate,
          outputField: aiOutputField.trim() || 'aiRecommendation',
          context: {
            customer: { id: 'CUST-1001', name: 'Example Subscriber', tier: 'VIP', accountAgeMonths: 24, monthlySpend: 85 },
            account: { balance: 450, status: 'active' },
            transaction: { id: 'TX-901', amount: 150, category: 'software' }
          }
        })
      });
      const outKey = aiOutputField.trim() || 'aiRecommendation';
      const output = res[outKey] || res;
      setAiTestFeedback(`Connected & Inferred: ${JSON.stringify(output)}`);
    } catch (err) {
      setAiTestFeedback(`API Test Failed: ${err.message}`);
    } finally {
      setAiTesting(false);
    }
  };

  const handleTestMlNode = async () => {
    setMlTesting(true);
    setMlTestFeedback(null);
    let mapping = {};
    try { mapping = JSON.parse(mlInputMapping); } catch {}
    try {
      const res = await apiRequest('/watsonx/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'watsonx_ml',
          endpoint: mlEndpoint.trim(),
          spaceId: mlSpaceId.trim(),
          apiKey: mlApiKey.trim(),
          deploymentId: mlDeploymentId.trim() || 'deployment-churn-risk-v1',
          scoringType: mlScoringType,
          inputMapping: mapping,
          outputField: mlOutputField.trim() || 'mlScore',
          context: {
            customer: { id: 'CUST-1001', accountAgeMonths: 24, monthlySpend: 85, tier: 'VIP' }
          }
        })
      });
      const outKey = mlOutputField.trim() || 'mlScore';
      const output = res[outKey] || res;
      setMlTestFeedback(`Scoring Succeeded: ${JSON.stringify(output)}`);
    } catch (err) {
      setMlTestFeedback(`Model Test Failed: ${err.message}`);
    } finally {
      setMlTesting(false);
    }
  };

  // Drag and drop from palette
  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow-nodetype', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData('application/reactflow-nodetype');
      if (!editableRef.current || !nodeType || nodeType === 'functionNode') return;

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = rfInstance
        ? rfInstance.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY
          })
        : {
            x: event.clientX - reactFlowBounds.left,
            y: event.clientY - reactFlowBounds.top
          };

      const newId = `node_${crypto.randomUUID()}`;
      let defaultContent = {};
      let defaultName = 'New Node';

      if (nodeType === 'inputNode') {
        defaultName = 'Request Input';
      } else if (nodeType === 'decisionTableNode') {
        defaultName = 'Decision Table';
        defaultContent = {
          hitPolicy: 'first',
          inputs: [{ id: 'in_1', field: 'customer.tier', name: 'Customer Tier' }],
          outputs: [{ id: 'out_1', field: 'discount', name: 'Discount %' }],
          rules: [{ _id: 'r1', _description: 'VIP discount', in_1: 'VIP', out_1: '20' }]
        };
      } else if (nodeType === 'expressionNode') {
        defaultName = 'Expression Calc';
        defaultContent = {
          expressions: [{ key: 'finalTotal', value: 'cart.total * 0.9' }]
        };
      } else if (nodeType === 'functionNode') {
        defaultName = 'Function Logic';
        defaultContent = {
          source: 'output = {"processed": True}'
        };
      } else if (nodeType === 'watsonxAiNode') {
        defaultName = 'watsonx.ai Reasoning';
        defaultContent = {
          endpoint: '',
          projectId: '',
          apiKey: '',
          modelId: 'ibm/granite-13b-instruct-v2',
          promptTemplate: 'Analyze customer {customer.name} with spend {customer.monthlySpend}. Return recommended action.',
          outputField: 'aiRecommendation'
        };
      } else if (nodeType === 'watsonxMlNode') {
        defaultName = 'watsonx ML Scorer';
        defaultContent = {
          endpoint: '',
          spaceId: '',
          apiKey: '',
          deploymentId: 'deployment-churn-risk-v1',
          scoringType: 'classification',
          inputMapping: { 'account_age': 'customer.accountAgeMonths', 'monthly_charges': 'customer.monthlySpend' },
          outputField: 'mlScore'
        };
      } else if (nodeType === 'switchNode') {
        defaultName = 'Switch Router';
        defaultContent = {
          statements: [{ id: 's1', condition: 'total > 100' }]
        };
      } else if (nodeType === 'outputNode') {
        defaultName = 'Response Output';
        defaultContent = { schema: [] };
      }

      const modern = modernNodeDefaults(nodeType);
      if (modern) { defaultName = modern.name; defaultContent = modern.content; }
      const newNode = {
        id: newId,
        type: 'custom',
        position,
        data: {
          editable: true,
          nodeType,
          name: defaultName,
          content: defaultContent,
          summary: nodeType === 'decisionTableNode' ? '1 Rule (first)' : nodeType,
          onDelete: id => handlers.current.deleteNode(id),
          onEdit: id => handlers.current.openEdit(id)
        }
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [rfInstance]
  );

  const handleExportToGraph = async () => {
    const updatedModel = { ...modelRef.current, graph: exportGraph() };
    if (editable) {
      onSaveGraph?.(updatedModel);
      await onSaveAndRun?.(updatedModel);
    } else {
      await onEvaluate?.(updatedModel);
    }
  };

  const handleAddNodeFromPalette = (nodeType) => {
    if (!editable || nodeType === 'functionNode') return;
    const newId = `node_${crypto.randomUUID()}`;
    let defaultContent = {};
    let defaultName = 'New Node';

    if (nodeType === 'inputNode') {
      defaultName = 'Request Input';
    } else if (nodeType === 'decisionTableNode') {
      defaultName = 'Decision Table';
      defaultContent = {
        hitPolicy: 'first',
        inputs: [{ id: 'in_1', field: 'customer.tier', name: 'Customer Tier' }],
        outputs: [{ id: 'out_1', field: 'discount', name: 'Discount %' }],
        rules: [{ _id: 'r1', _description: 'VIP discount', in_1: 'VIP', out_1: '20' }]
      };
    } else if (nodeType === 'expressionNode') {
      defaultName = 'Expression Calc';
      defaultContent = {
        expressions: [{ key: 'finalTotal', value: 'cart.total * 0.9' }]
      };
    } else if (nodeType === 'functionNode') {
      defaultName = 'Function Logic';
      defaultContent = {
        source: 'output = {"processed": True}'
      };
    } else if (nodeType === 'watsonxAiNode') {
      defaultName = 'watsonx.ai Reasoning';
      defaultContent = {
        endpoint: '',
        projectId: '',
        apiKey: '',
        modelId: 'ibm/granite-13b-instruct-v2',
        promptTemplate: 'Analyze customer {customer.name} with spend {customer.monthlySpend}. Return recommended action.',
        outputField: 'aiRecommendation'
      };
    } else if (nodeType === 'watsonxMlNode') {
      defaultName = 'watsonx ML Scorer';
      defaultContent = {
        endpoint: '',
        spaceId: '',
        apiKey: '',
        deploymentId: 'deployment-churn-risk-v1',
        scoringType: 'classification',
        inputMapping: { 'account_age': 'customer.accountAgeMonths', 'monthly_charges': 'customer.monthlySpend' },
        outputField: 'mlScore'
      };
    } else if (nodeType === 'switchNode') {
      defaultName = 'Switch Router';
      defaultContent = {
        statements: [{ id: 's1', condition: 'total > 100' }]
      };
    } else if (nodeType === 'outputNode') {
      defaultName = 'Response Output';
    }

    const modern = modernNodeDefaults(nodeType);
    if (modern) { defaultName = modern.name; defaultContent = modern.content; }

    let nextX = 100;
    let nextY = 160;
    if (nodes.length > 0) {
      const maxX = Math.max(...nodes.map(n => n.position?.x ?? 100));
      nextX = maxX + 260;
      const lastNode = nodes[nodes.length - 1];
      nextY = lastNode?.position?.y ?? 160;
    }

    const newNode = {
      id: newId,
      type: 'custom',
      position: { x: nextX, y: nextY },
      data: {
        editable: true,
        nodeType,
        name: defaultName,
        content: defaultContent,
        summary: nodeType === 'decisionTableNode'
          ? '1 Rules (first)'
          : nodeType === 'expressionNode'
          ? '1 Expressions'
          : nodeType === 'watsonxAiNode'
          ? 'ibm/granite-13b -> aiRecommendation'
          : nodeType === 'watsonxMlNode'
          ? 'deployment-churn-risk-v1 -> mlScore'
          : `${nodeType} definition`,
        onDelete: id => handlers.current.deleteNode(id),
        onEdit: id => handlers.current.openEdit(id)
      }
    };
    setNodes((nds) => nds.concat(newNode));

    if (nodes.length > 0) {
      const prevNode = nodes[nodes.length - 1];
      if (prevNode?.data?.nodeType !== 'outputNode' && nodeType !== 'inputNode') {
        const newEdge = {
          id: `edge_${crypto.randomUUID()}`,
          source: prevNode.id,
          target: newId,
          animated: true,
          style: { stroke: 'var(--cds-focus, #0f62fe)', strokeWidth: 2 }
        };
        setEdges((eds) => eds.concat(newEdge));
      }
    }

    setTimeout(() => {
      if (rfInstance) {
        rfInstance.fitView({ padding: 0.2, minZoom: 0.01, maxZoom: 1.2, duration: 250 });
      }
    }, 50);
  };

  const handleAutoLayout = useCallback(() => {
    if (!editable || nodes.length === 0) return;
    const adj = {};
    const inDegree = {};
    nodes.forEach(n => {
      adj[n.id] = [];
      inDegree[n.id] = 0;
    });
    edges.forEach(e => {
      if (adj[e.source]) adj[e.source].push(e.target);
      if (inDegree[e.target] !== undefined) inDegree[e.target]++;
    });

    const depth = {};
    const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
    queue.forEach(id => { depth[id] = 0; });

    const visited = new Set();
    while (queue.length > 0) {
      const curr = queue.shift();
      visited.add(curr);
      const currDepth = depth[curr] || 0;
      for (const neighbor of (adj[curr] || [])) {
        depth[neighbor] = Math.max(depth[neighbor] || 0, currDepth + 1);
        if (!visited.has(neighbor) && !queue.includes(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    nodes.forEach(n => {
      if (depth[n.id] === undefined) depth[n.id] = 0;
    });

    const layers = {};
    nodes.forEach(n => {
      const d = depth[n.id];
      if (!layers[d]) layers[d] = [];
      layers[d].push(n);
    });

    const newPositions = {};
    Object.keys(layers).sort((a, b) => Number(a) - Number(b)).forEach(dStr => {
      const d = Number(dStr);
      const layerNodes = layers[d];
      const count = layerNodes.length;
      layerNodes.forEach((node, idx) => {
        const x = 100 + d * 280;
        const y = 180 + (idx - (count - 1) / 2) * 160;
        newPositions[node.id] = { x, y };
      });
    });

    setNodes(nds => nds.map(n => ({
      ...n,
      position: newPositions[n.id] || n.position
    })));

    setTimeout(() => {
      if (rfInstance) {
        rfInstance.fitView({ padding: 0.2, minZoom: 0.01, maxZoom: 1.2, duration: 250 });
      }
    }, 60);
  }, [editable, nodes, edges, rfInstance]);

  const paletteItems = [
    { type: 'inputNode', label: 'Input Data', category: 'Input Schema', tagType: 'blue', accentColor: '#0f62fe', icon: <Flow size={16} /> },
    { type: 'decisionTableNode', label: 'Decision Table', category: 'Rule Task', tagType: 'purple', accentColor: themeCssValue('#8a3ffc'), icon: <DecisionTree size={16} /> },
    { type: 'watsonxAiNode', label: 'watsonx.ai', category: 'Generative AI', tagType: 'magenta', accentColor: '#ee5396', icon: <Bot size={16} /> },
    { type: 'watsonxMlNode', label: 'watsonx ML', category: 'Predictive ML', tagType: 'teal', accentColor: '#007d79', icon: <Analytics size={16} /> },
    { type: 'expressionNode', label: 'Expression', category: 'Action Task', tagType: 'cyan', accentColor: '#1192e8', icon: <Code size={16} /> },
    { type: 'switchNode', label: 'Switch Router', category: 'Branch Gateway', tagType: 'warm-gray', accentColor: '#ff832b', icon: <Flow size={16} /> },
    { type: 'actionRuleNode', label: 'Business Rule', category: 'Business Policy', tagType: 'purple', accentColor: themeCssValue('#8a3ffc'), icon: <DecisionTree size={16} /> },
    { type: 'inferenceNode', label: 'Fact Inference', category: 'Rule Agenda', tagType: 'teal', accentColor: '#007d79', icon: <Analytics size={16} /> },
    { type: 'forkNode', label: 'Parallel Fork', category: 'Parallel Paths', tagType: 'cyan', accentColor: '#1192e8', icon: <Flow size={16} /> },
    { type: 'joinNode', label: 'Parallel Join', category: 'Merge Results', tagType: 'cyan', accentColor: '#1192e8', icon: <Flow size={16} /> },
    { type: 'outputNode', label: 'Output Verdict', category: 'Decision Outcome', tagType: 'green', accentColor: '#24a148', icon: <Flow size={16} /> }
  ];

  return (
    <div className="decisions-mt-06" >
      {evaluationResult && <Tile className="decisions-mb-05" aria-live="polite">
        <h3 className="decisions-type-heading-01">Decision result</h3>
        <CodeSnippet type="multi">{JSON.stringify(evaluationResult.result, null, 2)}</CodeSnippet>
        <Button kind="ghost" size="sm" onClick={onShowResults}>View input and execution trace</Button>
      </Tile>}
      {/* Top Drag & Drop Palette */}
      <Tile className="decisions-mb-05 decisions-p-04-05" >
        <div className="decisions-gap-05" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div className="decisions-type-heading-01 decisions-mb-02" >
              Decision Flow Task Palette
            </div>
            <div className="decisions-type-label-01" style={{ color: 'var(--cds-text-secondary)' }}>
              Drag decision tasks, rule tables, and AI scoring boxes onto the canvas to construct decision flows.
            </div>
          </div>

          <div className="decisions-gap-03" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
            {paletteItems.map((item) => (
              <div
                key={item.type}
                role="button" tabIndex={editable ? 0 : -1} aria-disabled={!editable}
                draggable={editable}
                onKeyDown={event => { if (editable && ['Enter', ' '].includes(event.key)) { event.preventDefault(); handleAddNodeFromPalette(item.type); } }}
                onDragStart={(e) => onDragStart(e, item.type)}
                onClick={() => handleAddNodeFromPalette(item.type)}
                title={`Drag or click to add ${item.label} (${item.category})`}
                className="decisions-type-label-01 decisions-gap-03 decisions-p-03-04"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: '4px',
                  border: '1px solid var(--cds-border-subtle, #393939)',
                  borderLeft: `4px solid ${item.accentColor}`,
                  backgroundColor: 'var(--cds-layer-02, #262626)',
                  cursor: editable ? 'grab' : 'default',
                  userSelect: 'none',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                  transition: 'transform 0.15s ease'
                }}
              >
                {item.icon}
                <span className="decisions-type-heading-01">{item.label}</span>
                <Tag type={item.tagType} size="sm" className="decisions-m-00 decisions-node-eyebrow">
                  {item.category}
                </Tag>
              </div>
            ))}
          </div>

          <div className="decisions-gap-03" style={{ display: 'flex' }}>
            {editable && onOpenBobDesigner && (
              <Button
                size="sm"
                kind="tertiary"
                renderIcon={Bot}
                onClick={onOpenBobDesigner}
              >
                Design with Bob
              </Button>
            )}
            <Button
              size="sm"
              kind="tertiary"
              renderIcon={Bot}
              disabled={!editable}
              onClick={() => {
                if (!editable) return;
                setWatsonxBoxNode(null);
                setIsWatsonxBoxModalOpen(true);
              }}
            >
              + watsonx Box
            </Button>
            <Button
              size="sm"
              kind="ghost"
              renderIcon={Flow}
              disabled={!editable || nodes.length === 0}
              onClick={handleAutoLayout}
              title="Organize nodes into a clean topological flow"
            >
              Auto Layout
            </Button>
            <Button
              size="sm"
              kind="ghost"
              renderIcon={ZoomIn}
              onClick={zoomToFlow}
            >
              Zoom to Flow
            </Button>
            <Button
              size="sm"
              kind="secondary"
              renderIcon={Reset}
              onClick={zoomToFlow}
            >
              Reset view
            </Button>
            <Button
              size="sm"
              kind="primary"
              renderIcon={Play}
              onClick={handleExportToGraph}
              disabled={isBusy}
            >
              {isBusy ? 'Working…' : editable ? 'Save decision & Run' : 'Run saved decision'}
            </Button>
          </div>
        </div>
      </Tile>

      {/* React Flow Canvas */}
      <div
        ref={reactFlowWrapper}
        style={{
          height: 'calc(100vh - 240px)',
          minHeight: '720px',
          width: '100%',
          backgroundColor: 'var(--cds-layer-01)',
          border: '1px solid var(--cds-border-subtle)',
          borderRadius: '6px',
          position: 'relative'
        }}
      >
        <ReactFlow
          nodes={nodes}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={editable}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setRfInstance}
          onDrop={onDrop}
          onDragOver={onDragOver}
          fitView
          minZoom={0.01}
          fitViewOptions={{ padding: 0.2, minZoom: 0.01, maxZoom: 1.2 }}
        >
          <FitVisibleFlow active={active} wrapper={reactFlowWrapper} graph={JSON.stringify(model?.graph || {})} />
          <Background color="var(--cds-border-subtle-01)" gap={16} />
          <Controls showInteractive={editable} />
        </ReactFlow>
      </div>


      {!editable && <InlineNotification kind="info" title="Read-only graph" subtitle="You can inspect and navigate this decision, but only its owner or an administrator can edit it." hideCloseButton />}
      {/* Visual Rule / Node Configuration Modal */}
      <Modal
        open={!!editingNode}
        modalHeading={`Configure ${editingNode?.data?.nodeType || 'Node'}`}
        primaryButtonText="Save Node Rules"
        secondaryButtonText="Cancel"
        size="lg"
        onRequestClose={() => setEditingNode(null)}
        onRequestSubmit={handleSaveModal}
        primaryButtonDisabled={!editable}
      >
        <TextInput
          id="modal-node-name"
          labelText="Node Name"
          value={editNodeName}
          onChange={(e) => setEditNodeName(e.target.value)}
          className="decisions-mb-06" 
        />

        {MODERN_TYPES.includes(editingNodeType) && <>
          {modernError && <InlineNotification kind="error" title="Cannot save configuration" subtitle={modernError} hideCloseButton />}
          <ModernNodeEditor type={editingNodeType} draft={modernDraft} onChange={setModernDraft} joins={nodes.filter(node => node.data.nodeType === 'joinNode')} />
        </>}

        {/* DECISION TABLE EDITOR */}
        {editingNode?.data?.nodeType === 'decisionTableNode' && (
          <div>
            <div className="decisions-mb-05" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ width: '240px' }}>
                <Select
                  id="modal-table-hit-policy"
                  labelText="Hit Policy"
                  value={tableHitPolicy}
                  onChange={(e) => setTableHitPolicy(e.target.value)}
                >
                  <SelectItem value="first" text="First Match (first)" />
                  <SelectItem value="collect" text="Collect All (collect)" />
                  <SelectItem value="ruleOrder" text="Rule Order (ruleOrder)" />
                </Select>
              </div>

              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Add}
                onClick={handleAddRuleRow}
              >
                Add Rule Row
              </Button>
            </div>

            {/* Column Creator Bar */}
            <Tile className="decisions-mb-05 decisions-p-04" >
              <div className="decisions-type-label-01 decisions-mb-03" >
                Add New Table Column:
              </div>
              <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <TextInput
                    id="new-col-field"
                    labelText="Field Path"
                    value={newColField}
                    onChange={(e) => setNewColField(e.target.value)}
                    placeholder="e.g. customer.age or discount"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextInput
                    id="new-col-name"
                    labelText="Column Header"
                    value={newColName}
                    onChange={(e) => setNewColName(e.target.value)}
                    placeholder="e.g. Age or Discount %"
                  />
                </div>
                <div style={{ width: '140px' }}>
                  <Select
                    id="new-col-type"
                    labelText="Type"
                    value={newColType}
                    onChange={(e) => setNewColType(e.target.value)}
                  >
                    <SelectItem value="input" text="Input Condition" />
                    <SelectItem value="output" text="Output Action" />
                  </Select>
                </div>
                <Button size="md" kind="secondary" renderIcon={Add} onClick={handleAddColumn}>
                  Add Column
                </Button>
              </div>
            </Tile>

            {/* Rules Matrix Table */}
            <div style={{ overflowX: 'auto', maxHeight: '350px' }}>
              <Table size="md" aria-label="Decision node rules" className="decisions-type-body-compact-01" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ backgroundColor: 'var(--cds-layer-02)', borderBottom: '2px solid var(--cds-border-subtle-01)' }}>
                    <th className="decisions-p-03" style={{ textAlign: 'left' }}>#</th>
                    <th className="decisions-p-03" style={{ textAlign: 'left' }}>Description</th>
                    {tableInputs.map((inp) => (
                      <th key={inp.id} className="decisions-p-03" style={{ textAlign: 'left', color: 'var(--cds-link-primary)' }}>
                        IN: {inp.name || inp.field}
                        <Button hasIconOnly size="sm" kind="ghost" renderIcon={TrashCan} iconDescription={`Remove input column ${inp.name || inp.field}`} onClick={() => handleDeleteColumn(inp.id, 'input')} />
                      </th>
                    ))}
                    {tableOutputs.map((out) => (
                      <th key={out.id} className="decisions-p-03" style={{ textAlign: 'left', color: 'var(--cds-support-success)' }}>
                        OUT: {out.name || out.field}
                        <Button hasIconOnly size="sm" kind="ghost" renderIcon={TrashCan} iconDescription={`Remove output column ${out.name || out.field}`} onClick={() => handleDeleteColumn(out.id, 'output')} />
                      </th>
                    ))}
                    <th className="decisions-p-03" style={{ textAlign: 'center', width: '50px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRules.map((rule, rIdx) => (
                    <tr key={rule._id || rIdx} style={{ borderBottom: '1px solid var(--cds-border-subtle-01)' }}>
                      <td className="decisions-p-03" >{rIdx + 1}</td>
                      <td className="decisions-p-03" >
                        <input
                          type="text"
                          value={rule._description || ''}
                          onChange={(e) => handleRuleCellChange(rIdx, '_description', e.target.value)}
                          placeholder="Rule description"
                          className="decisions-p-02" style={{ background: 'transparent', border: '1px solid var(--cds-border-subtle-01)', borderRadius: '3px', color: 'var(--cds-text-primary)', width: '140px' }}
                        />
                      </td>
                      {tableInputs.map((inp) => (
                        <td key={inp.id} className="decisions-p-03" >
                          <input
                            type="text"
                            value={rule[inp.id] ?? '-'}
                            onChange={(e) => handleRuleCellChange(rIdx, inp.id, e.target.value)}
                            placeholder="e.g. >= 100, 'VIP', -"
                            className="decisions-type-code-01 decisions-p-02-03" style={{ background: 'transparent', border: '1px solid var(--cds-border-subtle-01)', borderRadius: '3px', color: 'var(--cds-text-primary)', width: '110px' }}
                          />
                        </td>
                      ))}
                      {tableOutputs.map((out) => (
                        <td key={out.id} className="decisions-p-03" >
                          <input
                            type="text"
                            value={rule[out.id] ?? '0'}
                            onChange={(e) => handleRuleCellChange(rIdx, out.id, e.target.value)}
                            placeholder="e.g. 25, true"
                            className="decisions-type-code-01 decisions-p-02-03" style={{ background: 'transparent', border: '1px solid var(--cds-border-subtle-01)', borderRadius: '3px', color: 'var(--cds-text-primary)', width: '110px' }}
                          />
                        </td>
                      ))}
                      <td className="decisions-p-03" style={{ textAlign: 'center' }}>
                        <Button
                          hasIconOnly
                          size="sm"
                          kind="ghost"
                          renderIcon={TrashCan}
                          iconDescription="Delete Rule"
                          onClick={() => handleDeleteRuleRow(rIdx)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        )}

        {editingNode?.data?.nodeType === 'switchNode' && <div>
          <p className="cds--body-01">Branches are evaluated in order. An empty condition is the fallback. Each branch has its own output handle; removing a branch removes its outgoing connections.</p>
          {switchError && <InlineNotification kind="error" title="Invalid branches" subtitle={switchError} hideCloseButton />}
          {switchStatements.map((statement, index) => <div key={statement.id} className="decisions-mt-04 decisions-gap-03" style={{ display: 'flex', alignItems: 'end' }}>
            <TextInput id={`branch-id-${index}`} labelText={`Branch ${index + 1} identifier`} value={statement.id} readOnly />
            <TextInput id={`branch-condition-${index}`} labelText={`Branch ${index + 1} condition`} value={statement.condition || ''} placeholder="Empty = fallback" onChange={event => setSwitchStatements(current => current.map((item, i) => i === index ? { ...item, condition: event.target.value } : item))} />
            <Button kind="ghost" size="sm" disabled={index === 0} onClick={() => setSwitchStatements(current => { const reordered = [...current]; [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]]; return reordered; })}>Move branch {index + 1} up</Button>
            <Button kind="danger--ghost" size="sm" onClick={() => setSwitchStatements(current => current.filter((_, i) => i !== index))}>Remove branch {index + 1}</Button>
          </div>)}
          <Button kind="tertiary" className="decisions-mt-04" onClick={() => setSwitchStatements(current => [...current, { id: `branch_${crypto.randomUUID()}`, condition: '' }])}>Add branch</Button>
        </div>}

        {/* EXPRESSION NODE EDITOR */}
        {editingNode?.data?.nodeType === 'expressionNode' && (
          <div>
            <div className="decisions-type-heading-01 decisions-mb-03" >Calculated Expressions:</div>
            {expressions.map((exp, idx) => (
              <div key={idx} className="decisions-gap-03 decisions-mb-03" style={{ display: 'flex', alignItems: 'center' }}>
                <code style={{ minWidth: '120px' }}>{exp.key}</code>
                <span>=</span>
                <code className="decisions-p-02-03" style={{ flex: 1, backgroundColor: 'var(--cds-layer-02)', borderRadius: '3px' }}>
                  {exp.value}
                </code>
                <Button
                  hasIconOnly
                  size="sm"
                  kind="ghost"
                  renderIcon={TrashCan}
                  iconDescription="Delete expression"
                  onClick={() => handleDeleteExpression(idx)}
                />
              </div>
            ))}

            <Tile className="decisions-mt-05 decisions-p-04" >
              <div className="decisions-type-label-01 decisions-mb-03" >Add Calculation:</div>
              <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <TextInput
                  id="new-exp-key"
                  labelText="Target Variable"
                  value={newExpKey}
                  onChange={(e) => setNewExpKey(e.target.value)}
                  placeholder="e.g. finalPrice"
                  style={{ width: '180px' }}
                />
                <TextInput
                  id="new-exp-val"
                  labelText="Expression Formula"
                  value={newExpVal}
                  onChange={(e) => setNewExpVal(e.target.value)}
                  placeholder="e.g. cart.total * (1 - discount/100)"
                  style={{ flex: 1 }}
                />
                <Button size="md" kind="tertiary" renderIcon={Add} onClick={handleAddExpression}>
                  Add Formula
                </Button>
              </div>
            </Tile>
          </div>
        )}

        {/* FUNCTION NODE EDITOR */}
        {editingNode?.data?.nodeType === 'functionNode' && (
          <div>
            <TextArea
              id="modal-func-source"
              labelText="Function Source Code (Python or JavaScript)"
              rows={10}
              value={functionSource}
              onChange={(e) => setFunctionSource(e.target.value)}
              helperText="Python: set output = {...}. JavaScript: const handler = (input, { moment, env }) => { return {...}; }"
              className="decisions-type-code-01" 
            />
          </div>
        )}

        {/* WATSONX.AI FOUNDATION MODEL NODE EDITOR */}
        {editingNode?.data?.nodeType === 'watsonxAiNode' && (
          <div className="decisions-flow-editor-form">
            <TextInput
              id="modal-ai-endpoint"
              labelText="watsonx.ai Service Endpoint"
              value={aiEndpoint}
              onChange={(e) => setAiEndpoint(e.target.value)}
              placeholder="https://us-south.ml.cloud.ibm.com (or custom CP4D watsonx endpoint)"
              helperText="Target watsonx.ai REST base URL or on-premises CP4D cluster endpoint."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ai-project"
              labelText="watsonx Project ID / Space ID"
              value={aiProjectId}
              onChange={(e) => setAiProjectId(e.target.value)}
              placeholder="e.g. 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
              helperText="The watsonx.ai project or deployment space ID containing authorized models."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ai-apikey"
              labelText="API Key / Bearer Token"
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              placeholder="API Key or IAM Bearer Token"
              helperText="Credentials for the watsonx.ai endpoint. Leave blank to inherit saved integration credentials."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ai-model"
              labelText="Foundation Model ID"
              value={aiModelId}
              onChange={(e) => setAiModelId(e.target.value)}
              placeholder="ibm/granite-13b-instruct-v2"
              helperText="Foundation model identifier (e.g. ibm/granite-13b-instruct-v2, ibm/granite-3-8b-instruct, meta-llama/llama-3-70b-instruct)."
              className="decisions-mb-04"
            />
            <TextArea
              id="modal-ai-prompt"
              labelText="Prompt Template with Context Variables"
              rows={4}
              value={aiPromptTemplate}
              onChange={(e) => setAiPromptTemplate(e.target.value)}
              placeholder="Analyze customer {customer.name} with monthly spend {customer.monthlySpend}. Return recommended offer."
              helperText="Interpolate decision context using {dot.path} (e.g. {customer.tier}, {transaction.amount})."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ai-output"
              labelText="Output Variable Name"
              value={aiOutputField}
              onChange={(e) => setAiOutputField(e.target.value)}
              placeholder="aiRecommendation"
              helperText="Context variable key where the generated output and extracted JSON will be stored."
              className="decisions-mb-04"
            />
            <div className="decisions-mt-03 decisions-mb-03">
              <Button
                size="sm"
                kind="tertiary"
                renderIcon={Play}
                onClick={handleTestAiNode}
                disabled={aiTesting}
              >
                {aiTesting ? 'Testing watsonx.ai...' : 'Test watsonx.ai Endpoint & Model'}
              </Button>
            </div>
            {aiTestFeedback && (
              <Tile className="decisions-p-03 decisions-mb-03">
                <code className="decisions-type-code-01">{aiTestFeedback}</code>
              </Tile>
            )}
          </div>
        )}

        {/* WATSONX ML PREDICTIVE DEPLOYMENT NODE EDITOR */}
        {editingNode?.data?.nodeType === 'watsonxMlNode' && (
          <div className="decisions-flow-editor-form">
            <TextInput
              id="modal-ml-endpoint"
              labelText="watsonx ML Service Endpoint"
              value={mlEndpoint}
              onChange={(e) => setMlEndpoint(e.target.value)}
              placeholder="https://us-south.ml.cloud.ibm.com (or custom WML endpoint)"
              helperText="watsonx Machine Learning / CP4D WML scoring service base URL."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ml-space"
              labelText="watsonx Space ID / Project ID"
              value={mlSpaceId}
              onChange={(e) => setMlSpaceId(e.target.value)}
              placeholder="e.g. space-4f5e6d-7c8b9a"
              helperText="Deployment space GUID hosting the predictive model deployment."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ml-apikey"
              labelText="API Key / Bearer Token"
              type="password"
              value={mlApiKey}
              onChange={(e) => setMlApiKey(e.target.value)}
              placeholder="API Key or IAM Bearer Token"
              helperText="Credentials for WML endpoint. Leave blank to inherit saved integration credentials."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ml-deployment"
              labelText="watsonx ML Deployment ID"
              value={mlDeploymentId}
              onChange={(e) => setMlDeploymentId(e.target.value)}
              placeholder="deployment-churn-risk-v1"
              helperText="WML Deployment identifier for scoring predictions."
              className="decisions-mb-04"
            />
            <Select
              id="modal-ml-type"
              labelText="Scoring Model Type"
              value={mlScoringType}
              onChange={(e) => setMlScoringType(e.target.value)}
              className="decisions-mb-04"
            >
              <SelectItem value="classification" text="Classification (Categorical Prediction + Probability)" />
              <SelectItem value="regression" text="Regression (Continuous Numeric Score)" />
            </Select>
            <TextArea
              id="modal-ml-mapping"
              labelText="Feature Input Mapping (JSON)"
              rows={4}
              value={mlInputMapping}
              onChange={(e) => setMlInputMapping(e.target.value)}
              placeholder='{"account_age": "customer.accountAgeMonths", "monthly_spend": "customer.monthlySpend"}'
              helperText="JSON mapping model feature column names to context variables."
              className="decisions-mb-04"
            />
            <TextInput
              id="modal-ml-output"
              labelText="Output Variable Name"
              value={mlOutputField}
              onChange={(e) => setMlOutputField(e.target.value)}
              placeholder="mlScore"
              helperText="Context variable key where the model predictions and probabilities will be stored."
              className="decisions-mb-04"
            />
            <div className="decisions-mt-03 decisions-mb-03">
              <Button
                size="sm"
                kind="tertiary"
                renderIcon={Play}
                onClick={handleTestMlNode}
                disabled={mlTesting}
              >
                {mlTesting ? 'Testing watsonx ML...' : 'Test watsonx Model Deployment'}
              </Button>
            </div>
            {mlTestFeedback && (
              <Tile className="decisions-p-03 decisions-mb-03">
                <code className="decisions-type-code-01">{mlTestFeedback}</code>
              </Tile>
            )}
          </div>
        )}
      </Modal>

      <AddWatsonxBoxModal
        isOpen={isWatsonxBoxModalOpen}
        onClose={() => {
          setIsWatsonxBoxModalOpen(false);
          setWatsonxBoxNode(null);
        }}
        model={model}
        onUpdateModel={(updatedModel) => {
          if (!editable) return;
          onSaveGraph?.(updatedModel);
        }}
        existingNode={watsonxBoxNode}
        editable={editable}
      />
    </div>
  );
}
