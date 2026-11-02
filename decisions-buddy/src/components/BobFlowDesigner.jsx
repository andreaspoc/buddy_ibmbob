import React, { useState } from 'react';
import {
  Modal,
  TextInput,
  TextArea,
  Button,
  InlineLoading,
  InlineNotification,
  Tag,
  Tile,
  Stack,
  CodeSnippet
} from '@carbon/react';
import { Bot, Flow, Play, MagicWand, WatsonHealthAiStatusComplete } from '@carbon/icons-react';
import { apiRequest } from '../config.js';

const PRESETS = [
  {
    title: 'Customer Retention & Churn Offers',
    badge: 'watsonx ML',
    tagType: 'cyan',
    prompt: 'Design a customer churn retention flow using a watsonx ML predictive churn deployment, then evaluate tiered discounts and free speed boost perks in a decision table.'
  },
  {
    title: 'Real-time Fraud & Anomaly Triage',
    badge: 'watsonx.ai',
    tagType: 'purple',
    prompt: 'Create a fraud anomaly detection flow with a watsonx.ai foundation model analyzing transaction context, followed by a decision table gating MFA challenges.'
  },
  {
    title: 'Loan Underwriting Matrix with ML Scoring',
    badge: 'watsonx AI + ML',
    tagType: 'blue',
    prompt: 'Build an automated underwriting matrix combining watsonx ML credit risk scoring with APR calculations and decision table tier rules.'
  },
  {
    title: 'Tiered VIP Branching & Switch Router',
    badge: 'Switch Router',
    tagType: 'teal',
    prompt: 'Create a customer loyalty flow with a switch router: VIP members route to a premier perks table with 25% discount, while standard members route to a standard base table.'
  },
  {
    title: 'Order Pricing & Tax Expression Pipeline',
    badge: 'Expressions',
    tagType: 'green',
    prompt: 'Design an e-commerce order decision flow with a promotional discount table followed by an expression calculation node computing tax, shipping fees, and final total.'
  }
];

export default function BobFlowDesigner({ isOpen, onClose, onApplyFlow, currentGraph }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatedFlow, setGeneratedFlow] = useState(null);

  const handleGenerate = async (customPrompt) => {
    const textToUse = customPrompt || prompt;
    if (!textToUse.trim()) return;

    try {
      setLoading(true);
      setError(null);
      const result = await apiRequest('/assistant/generate-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: textToUse.trim(), currentGraph })
      });
      setGeneratedFlow(result);
    } catch (err) {
      setError(err.message || 'Failed to design flow with Bob');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!generatedFlow) return;
    onApplyFlow?.({
      name: generatedFlow.name,
      description: generatedFlow.description,
      graph: generatedFlow.graph,
      defaultInput: generatedFlow.defaultInput
    });
    onClose?.();
  };

  return (
    <Modal
      open={isOpen}
      modalHeading="Design Decision Flows with Buddy (BOB)"
      modalLabel="AI Flow Designer & watsonx Integration"
      primaryButtonText={generatedFlow ? 'Apply Flow to Decision' : 'Generate Flow with Bob'}
      secondaryButtonText="Close"
      primaryButtonDisabled={loading || (!generatedFlow && !prompt.trim())}
      onRequestClose={onClose}
      onRequestSubmit={generatedFlow ? handleApply : () => handleGenerate().catch(err => setError(err?.message || 'Failed to design flow with Bob'))}
      size="lg"
    >
      <Stack gap={5}>
        <p className="cds--body-01">
          Ask Bob to generate complete decision flows incorporating IBM watsonx.ai foundation models,
          watsonx ML predictive scoring components, decision tables, and expressions.
        </p>

        <div>
          <div className="sidebar-section-title">Quick Presets</div>
          <div className="decisions-actions">
            {PRESETS.map((preset, idx) => (
              <Button
                key={idx}
                size="sm"
                kind="tertiary"
                renderIcon={MagicWand}
                onClick={() => {
                  setPrompt(preset.prompt);
                  handleGenerate(preset.prompt).catch(err => setError(err?.message || 'Failed to design flow with Bob'));
                }}
              >
                {preset.title}
              </Button>
            ))}
          </div>
        </div>

        <TextArea
          id="bob-flow-prompt"
          labelText="Describe the decision flow or business logic you need"
          placeholder="e.g. Design a flow with watsonx ML predicting customer churn, followed by tiered retention discounts..."
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {loading && <InlineLoading description="Bob is designing your decision flow and configuring watsonx nodes…" />}
        {error && <InlineNotification kind="error" title="Flow generation failed" subtitle={error} onCloseButtonClick={() => setError(null)} />}

        {generatedFlow && (
          <Tile className="decisions-flow-preview-tile">
            <Stack gap={4}>
              <div className="decisions-node-badge">
                <Bot size={16} />
                <strong>{generatedFlow.name}</strong>
              </div>
              <p className="cds--body-01">{generatedFlow.explanation}</p>
              
              <div>
                <div className="sidebar-section-title">Generated Flow Nodes</div>
                <div className="decisions-actions">
                  {(generatedFlow.graph?.nodes || []).map((node) => (
                    <Tag
                      key={node.id}
                      type={
                        node.type === 'watsonxAiNode' ? 'purple' :
                        node.type === 'watsonxMlNode' ? 'cyan' :
                        node.type === 'decisionTableNode' ? 'magenta' :
                        node.type === 'expressionNode' ? 'teal' :
                        node.type === 'outputNode' ? 'green' : 'blue'
                      }
                    >
                      {node.name} ({node.type})
                    </Tag>
                  ))}
                </div>
              </div>

              <div>
                <div className="sidebar-section-title">Sample Test Payload</div>
                <CodeSnippet type="multi">
                  {JSON.stringify(generatedFlow.defaultInput || {}, null, 2)}
                </CodeSnippet>
              </div>
            </Stack>
          </Tile>
        )}
      </Stack>
    </Modal>
  );
}
