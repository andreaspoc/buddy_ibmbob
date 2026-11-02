import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  TextInput,
  TextArea,
  Select,
  SelectItem,
  Checkbox,
  Button,
  Tile,
  Tag,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel
} from '@carbon/react';
import { Bot, Analytics, Play } from '@carbon/icons-react';
import { apiRequest } from '../config.js';

export default function AddWatsonxBoxModal(props) {
  if (!props.isOpen) return null;
  return <WatsonxBoxForm key={props.existingNode?.id || 'new-watsonx-box'} {...props} />;
}

function WatsonxBoxForm({ isOpen, onClose, model, onUpdateModel, existingNode = null, editable = true }) {
  const isEditing = Boolean(existingNode);
  const initialType = existingNode?.type === 'watsonxMlNode' ? 1 : 0;
  const [selectedTab, setSelectedTab] = useState(initialType);

  // watsonx.ai state
  const aiContent = existingNode?.type === 'watsonxAiNode' ? existingNode.content || {} : {};
  const [aiEndpoint, setAiEndpoint] = useState(aiContent.endpoint || aiContent.baseUrl || 'https://us-south.ml.cloud.ibm.com');
  const [aiProjectId, setAiProjectId] = useState(aiContent.projectId || aiContent.project_id || '');
  const [aiApiKey, setAiApiKey] = useState(aiContent.apiKey || '');
  const [aiModelId, setAiModelId] = useState(aiContent.modelId || 'ibm/granite-13b-instruct-v2');
  const [aiPrompt, setAiPrompt] = useState(aiContent.promptTemplate || 'Analyze decision input for customer {customer.tier || value}. Return recommendation in JSON format { "decision": "APPROVE|REJECT", "riskScore": 0.1 }');
  const [aiOutputVar, setAiOutputVar] = useState(aiContent.outputField || 'aiRecommendation');

  // watsonx ML state
  const mlContent = existingNode?.type === 'watsonxMlNode' ? existingNode.content || {} : {};
  const [mlEndpoint, setMlEndpoint] = useState(mlContent.endpoint || mlContent.baseUrl || 'https://us-south.ml.cloud.ibm.com');
  const [mlSpaceId, setMlSpaceId] = useState(mlContent.spaceId || mlContent.space_id || '');
  const [mlApiKey, setMlApiKey] = useState(mlContent.apiKey || '');
  const [mlDeploymentId, setMlDeploymentId] = useState(mlContent.deploymentId || 'deployment-churn-risk-v1');
  const [mlScoringType, setMlScoringType] = useState(mlContent.scoringType || 'classification');
  const [mlMapping, setMlMapping] = useState(typeof mlContent.inputMapping === 'string' ? mlContent.inputMapping : JSON.stringify(mlContent.inputMapping || { 'customer_tier': 'customer.tier', 'account_value': 'value' }, null, 2));
  const [mlOutputVar, setMlOutputVar] = useState(mlContent.outputField || 'mlScore');

  // Wiring option
  const [autoWire, setAutoWire] = useState(true);

  // Testing state
  const [isTesting, setIsTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState(null);

  const testGeneration = useRef(0);
  useEffect(() => () => { testGeneration.current += 1; }, []);

  if (!isOpen) return null;

  const handleTestConnection = async (kind) => {
    if (!editable) return;
    const generation = ++testGeneration.current;
    setIsTesting(true);
    setTestFeedback(null);
    try {
      const payload = kind === 'ai' ? {
        kind: 'watsonx_ai',
        endpoint: aiEndpoint.trim(),
        projectId: aiProjectId.trim(),
        apiKey: aiApiKey.trim(),
        modelId: aiModelId.trim() || 'ibm/granite-13b-instruct-v2',
        promptTemplate: aiPrompt,
        outputField: aiOutputVar.trim() || 'aiRecommendation',
        context: { customer: { tier: 'VIP' }, value: 100 }
      } : {
        kind: 'watsonx_ml',
        endpoint: mlEndpoint.trim(),
        spaceId: mlSpaceId.trim(),
        apiKey: mlApiKey.trim(),
        deploymentId: mlDeploymentId.trim() || 'deployment-churn-risk-v1',
        scoringType: mlScoringType,
        inputMapping: (() => { try { return JSON.parse(mlMapping); } catch { return {}; } })(),
        outputField: mlOutputVar.trim() || 'mlScore',
        context: { customer: { tier: 'VIP' }, value: 100 }
      };

      const result = await apiRequest('/watsonx/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const key = kind === 'ai' ? (aiOutputVar.trim() || 'aiRecommendation') : (mlOutputVar.trim() || 'mlScore');
      const data = result[key] || result;
      if (generation !== testGeneration.current) return;
      setTestFeedback({ success: true, text: `API test connected successfully: ${JSON.stringify(data)}` });
    } catch (err) {
      if (generation !== testGeneration.current) return;
      setTestFeedback({ success: false, text: `API test failed: ${err.message}` });
    } finally {
      if (generation === testGeneration.current) setIsTesting(false);
    }
  };

  const handleApply = () => {
    if (!editable || !model || !model.graph) return;
    const isAi = selectedTab === 0;
    const nodeType = isAi ? 'watsonxAiNode' : 'watsonxMlNode';
    const outputField = isAi ? (aiOutputVar.trim() || 'aiRecommendation') : (mlOutputVar.trim() || 'mlScore');
    const endpoint = isAi ? aiEndpoint.trim() : mlEndpoint.trim();
    const modelOrDeploy = isAi ? (aiModelId.trim() || 'ibm/granite-13b-instruct-v2') : (mlDeploymentId.trim() || 'deployment-churn-risk-v1');

    let parsedMapping = {};
    if (!isAi) {
      try { parsedMapping = JSON.parse(mlMapping); if (!parsedMapping || typeof parsedMapping !== 'object' || Array.isArray(parsedMapping)) throw new Error('Use a JSON object'); } catch { setTestFeedback({ success: false, text: 'Input mapping must be a valid JSON object.' }); return; }
    }

    const content = isAi ? {
      ...(existingNode?.content || {}),
      endpoint,
      projectId: aiProjectId.trim(),
      apiKey: aiApiKey.trim(),
      modelId: modelOrDeploy,
      promptTemplate: aiPrompt,
      outputField,
      parameters: { temperature: 0.2, max_new_tokens: 150, decoding_method: 'greedy' }
    } : {
      ...(existingNode?.content || {}),
      endpoint,
      spaceId: mlSpaceId.trim(),
      apiKey: mlApiKey.trim(),
      deploymentId: modelOrDeploy,
      scoringType: mlScoringType,
      inputMapping: parsedMapping,
      outputField
    };

    const updated = JSON.parse(JSON.stringify(model));
    const nodes = updated.graph.nodes || [];
    const edges = updated.graph.edges || [];

    if (isEditing && existingNode) {
      // Update existing node in graph
      const targetIdx = nodes.findIndex(n => n.id === existingNode.id);
      if (targetIdx >= 0) {
        nodes[targetIdx].content = content;
        nodes[targetIdx].name = isAi ? `watsonx.ai (${modelOrDeploy})` : `watsonx ML (${modelOrDeploy})`;
      }
    } else {
      // Create new watsonx node box
      const newId = `watsonx_${Date.now()}`;
      const newNode = {
        id: newId,
        name: isAi ? `watsonx.ai (${modelOrDeploy})` : `watsonx ML (${modelOrDeploy})`,
        type: nodeType,
        position: { x: 320, y: 120 + (nodes.length % 3) * 60 },
        content
      };
      nodes.push(newNode);

      if (autoWire) {
        // Wire into decision: input -> watsonx -> decisionTable
        const inputNode = nodes.find(n => n.type === 'inputNode');
        const tableNode = nodes.find(n => n.type === 'decisionTableNode');
        const outputNode = nodes.find(n => n.type === 'outputNode');

        if (inputNode) {
          edges.push({ id: `edge_${inputNode.id}_${newId}`, sourceId: inputNode.id, targetId: newId });
        }

        if (tableNode) {
          edges.push({ id: `edge_${newId}_${tableNode.id}`, sourceId: newId, targetId: tableNode.id });

          // Add column in decision table for the watsonx output
          const tableContent = tableNode.content = tableNode.content || {};
          tableContent.inputs = tableContent.inputs || [];
          tableContent.rules = tableContent.rules || [];

          const colId = `col_watsonx_${Date.now()}`;
          const colField = isAi ? `${outputField}.recommendation` : `${outputField}.prediction`;
          const colName = isAi ? `AI: ${outputField}` : `ML: ${outputField}`;

          const alreadyHasCol = tableContent.inputs.some(i => i.field === colField);
          if (!alreadyHasCol) {
            tableContent.inputs.push({ id: colId, field: colField, name: colName });
            // Add pass-through condition '-' to existing rules
            tableContent.rules = tableContent.rules.map(r => ({
              ...r,
              [colId]: r[colId] !== undefined ? r[colId] : '-'
            }));
          }
        } else if (outputNode) {
          edges.push({ id: `edge_${newId}_${outputNode.id}`, sourceId: newId, targetId: outputNode.id });
        }
      }
    }

    updated.graph.nodes = nodes;
    updated.graph.edges = edges;
    onUpdateModel(updated);
    onClose();
  };

  return (
    <Modal
      open={isOpen}
      modalHeading={isEditing ? 'Configure watsonx Box' : 'Add watsonx Box to Decision'}
      primaryButtonText={isEditing ? 'Save watsonx Box' : 'Add to Decision'}
      secondaryButtonText="Cancel"
      size="lg"
      onRequestClose={onClose}
      onRequestSubmit={handleApply}
      primaryButtonDisabled={!editable}
    >
      <div className="decisions-mb-04">
        <p className="cds--body-01 decisions-mb-03">
          Configure a watsonx box with your custom endpoint and credentials to execute foundation models or predictive ML as an active part of this decision.
        </p>

        {!isEditing && (
          <Tabs selectedIndex={selectedTab} onChange={({ selectedIndex }) => { setSelectedTab(selectedIndex); setTestFeedback(null); }}>
            <TabList aria-label="watsonx Box Type">
              <Tab renderIcon={Bot}>watsonx.ai (Foundation Model)</Tab>
              <Tab renderIcon={Analytics}>watsonx ML (Predictive Model)</Tab>
            </TabList>
            <TabPanels>
              <TabPanel>{/* Tab 0 active */}</TabPanel>
              <TabPanel>{/* Tab 1 active */}</TabPanel>
            </TabPanels>
          </Tabs>
        )}

        {selectedTab === 0 ? (
          <div>
            <TextInput
              id="box-ai-endpoint"
              labelText="watsonx.ai Service Endpoint"
              value={aiEndpoint}
              onChange={(e) => setAiEndpoint(e.target.value)}
              placeholder="https://us-south.ml.cloud.ibm.com (or custom CP4D endpoint)"
              helperText="Target watsonx.ai REST base URL or on-premises CP4D cluster endpoint."
              className="decisions-mb-04 decisions-mt-03"
            />
            <TextInput
              id="box-ai-project"
              labelText="watsonx Project ID / Space ID"
              value={aiProjectId}
              onChange={(e) => setAiProjectId(e.target.value)}
              placeholder="e.g. 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
              helperText="Project space containing authorized foundation models."
              className="decisions-mb-04"
            />
            <TextInput
              id="box-ai-key"
              labelText="API Key / Bearer Token"
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              placeholder="API Key or IAM Token"
              helperText="Credentials for the watsonx.ai endpoint. Leave blank to inherit saved server credentials."
              className="decisions-mb-04"
            />
            <TextInput
              id="box-ai-model"
              labelText="Foundation Model ID"
              value={aiModelId}
              onChange={(e) => setAiModelId(e.target.value)}
              placeholder="ibm/granite-13b-instruct-v2"
              helperText="Model identifier (e.g. ibm/granite-13b-instruct-v2, ibm/granite-3-8b-instruct, meta-llama/llama-3-70b-instruct)."
              className="decisions-mb-04"
            />
            <TextArea
              id="box-ai-prompt"
              labelText="Prompt Template with Context Variables"
              rows={3}
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Analyze customer {customer.tier} with value {value}. Return decision JSON."
              helperText="Interpolate decision context with {field.path} placeholders."
              className="decisions-mb-04"
            />
            <TextInput
              id="box-ai-output"
              labelText="Output Variable Name"
              value={aiOutputVar}
              onChange={(e) => setAiOutputVar(e.target.value)}
              placeholder="aiRecommendation"
              helperText="Context variable key passed downstream to decision tables."
              className="decisions-mb-04"
            />

            <div className="decisions-mb-03 decisions-mt-03">
              <Button
                size="sm"
                kind="tertiary"
                renderIcon={Play}
                onClick={() => handleTestConnection('ai')}
                disabled={isTesting}
              >
                {isTesting ? 'Testing Endpoint…' : 'Test watsonx.ai Endpoint & Model'}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <TextInput
              id="box-ml-endpoint"
              labelText="watsonx ML Service Endpoint"
              value={mlEndpoint}
              onChange={(e) => setMlEndpoint(e.target.value)}
              placeholder="https://us-south.ml.cloud.ibm.com (or custom CP4D WML endpoint)"
              helperText="watsonx Machine Learning / CP4D WML scoring service base URL."
              className="decisions-mb-04 decisions-mt-03"
            />
            <TextInput
              id="box-ml-space"
              labelText="watsonx Space ID / Project ID"
              value={mlSpaceId}
              onChange={(e) => setMlSpaceId(e.target.value)}
              placeholder="e.g. space-4f5e6d-7c8b9a"
              helperText="Deployment space GUID hosting the predictive model."
              className="decisions-mb-04"
            />
            <TextInput
              id="box-ml-key"
              labelText="API Key / Bearer Token"
              type="password"
              value={mlApiKey}
              onChange={(e) => setMlApiKey(e.target.value)}
              placeholder="API Key or IAM Token"
              helperText="Credentials for WML endpoint."
              className="decisions-mb-04"
            />
            <TextInput
              id="box-ml-deploy"
              labelText="watsonx ML Deployment ID"
              value={mlDeploymentId}
              onChange={(e) => setMlDeploymentId(e.target.value)}
              placeholder="deployment-churn-risk-v1"
              helperText="WML Deployment identifier for scoring predictions."
              className="decisions-mb-04"
            />
            <Select
              id="box-ml-scoring-type"
              labelText="Scoring Model Type"
              value={mlScoringType}
              onChange={(e) => setMlScoringType(e.target.value)}
              className="decisions-mb-04"
            >
              <SelectItem value="classification" text="Classification (Categorical Prediction + Probability)" />
              <SelectItem value="regression" text="Regression (Continuous Numeric Score)" />
            </Select>
            <TextArea
              id="box-ml-mapping"
              labelText="Feature Input Mapping (JSON)"
              rows={3}
              value={mlMapping}
              onChange={(e) => setMlMapping(e.target.value)}
              placeholder='{"tenure": "customer.accountAgeMonths", "monthly_spend": "value"}'
              helperText="Maps decision context variables to predictive feature columns."
              className="decisions-mb-04"
            />
            <TextInput
              id="box-ml-output"
              labelText="Output Variable Name"
              value={mlOutputVar}
              onChange={(e) => setMlOutputVar(e.target.value)}
              placeholder="mlScore"
              helperText="Context variable key passed downstream to decision tables."
              className="decisions-mb-04"
            />

            <div className="decisions-mb-03 decisions-mt-03">
              <Button
                size="sm"
                kind="tertiary"
                renderIcon={Play}
                onClick={() => handleTestConnection('ml')}
                disabled={isTesting}
              >
                {isTesting ? 'Testing Deployment…' : 'Test watsonx Model API'}
              </Button>
            </div>
          </div>
        )}

        {testFeedback && (
          <Tile className="decisions-p-03 decisions-mb-04">
            <Tag type={testFeedback.success ? 'green' : 'red'} size="sm" className="decisions-mb-02">
              {testFeedback.success ? 'TEST SUCCEEDED' : 'TEST FAILED'}
            </Tag>
            <code className="decisions-type-code-01">{testFeedback.text}</code>
          </Tile>
        )}

        {!isEditing && (
          <Checkbox
            id="box-auto-wire"
            labelText="Automatically connect box to Decision Table and add input rule column"
            checked={autoWire}
            onChange={(_, { checked }) => setAutoWire(checked)}
            className="decisions-mt-03"
          />
        )}
      </div>
    </Modal>
  );
}
