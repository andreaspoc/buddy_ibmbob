import { themeCssValue } from '../../../../web/src/lib/themeColor.ts';
import React, { memo, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { Tag, Button } from '@carbon/react';
import { DecisionTree, Code, Flow, TrashCan, Settings, Bot, Analytics } from '@carbon/icons-react';

const themedNodeConfig = (config) => ({
  ...config,
  accentColor: themeCssValue(config.accentColor),
  headerBg: themeCssValue(config.headerBg),
  handleColor: themeCssValue(config.handleColor),
});

const getNodeConfig = (type) => {
  switch (type) {
    case 'inputNode':
      return {
        tagType: 'blue',
        category: 'Input Schema',
        label: 'Input Data',
        accentColor: '#0f62fe', // IBM Blue 60
        headerBg: '#0f62fe',
        handleColor: '#0f62fe',
        icon: <Flow size={16} />
      };
    case 'decisionTableNode':
      return {
        tagType: 'purple',
        category: 'Rule Task',
        label: 'Decision Table',
        accentColor: '#8a3ffc', // IBM Purple 60
        headerBg: '#6929c4', // IBM Purple 70
        handleColor: '#8a3ffc',
        icon: <DecisionTree size={16} />
      };
    case 'watsonxAiNode':
      return {
        tagType: 'magenta',
        category: 'Generative AI',
        label: 'Foundation Model',
        accentColor: '#ee5396', // IBM Magenta 50
        headerBg: '#9f1853', // IBM Magenta 70
        handleColor: '#ee5396',
        icon: <Bot size={16} />
      };
    case 'watsonxMlNode':
      return {
        tagType: 'teal',
        category: 'Predictive ML',
        label: 'Scoring Engine',
        accentColor: '#007d79', // IBM Teal 60
        headerBg: '#005d5d', // IBM Teal 70
        handleColor: '#007d79',
        icon: <Analytics size={16} />
      };
    case 'expressionNode':
      return {
        tagType: 'cyan',
        category: 'Action Task',
        label: 'Expression Logic',
        accentColor: '#1192e8', // IBM Cyan 50
        headerBg: '#00539a', // IBM Cyan 70
        handleColor: '#1192e8',
        icon: <Code size={16} />
      };
    case 'actionRuleNode':
    case 'businessRuleNode':
    case 'balRuleNode':
      return { tagType: 'purple', category: 'Business Policy', label: 'Business Action Rule', accentColor: '#8a3ffc', headerBg: '#6929c4', handleColor: '#8a3ffc', icon: <DecisionTree size={16} /> };
    case 'inferenceNode':
    case 'ruleAgendaNode':
      return { tagType: 'teal', category: 'Rule Agenda', label: 'Fact Inference', accentColor: '#007d79', headerBg: '#005d5d', handleColor: '#007d79', icon: <Analytics size={16} /> };
    case 'forkNode':
    case 'joinNode':
      return { tagType: 'cyan', category: 'Parallel Paths', label: type === 'forkNode' ? 'Parallel Fork' : 'Parallel Join', accentColor: '#1192e8', headerBg: '#00539a', handleColor: '#1192e8', icon: <Flow size={16} /> };
    case 'functionNode':
      return {
        tagType: 'magenta',
        category: 'Script Task',
        label: 'Function Node',
        accentColor: '#ee5396',
        headerBg: '#9f1853',
        handleColor: '#ee5396',
        icon: <Code size={16} />
      };
    case 'switchNode':
      return {
        tagType: 'warm-gray',
        category: 'Branch Gateway',
        label: 'Conditional Switch',
        accentColor: '#ff832b', // IBM Orange 40
        headerBg: '#ba4e00', // IBM Orange 60
        handleColor: '#ff832b',
        icon: <Flow size={16} />
      };
    case 'outputNode':
      return {
        tagType: 'green',
        category: 'Decision Outcome',
        label: 'Output Verdict',
        accentColor: '#24a148', // IBM Green 50
        headerBg: '#0e6027', // IBM Green 70
        handleColor: '#24a148',
        icon: <Flow size={16} />
      };
    default:
      return {
        tagType: 'cool-gray',
        category: 'Decision Task',
        label: type,
        accentColor: '#697077',
        headerBg: '#343a3f',
        handleColor: '#697077',
        icon: <Flow size={16} />
      };
  }
};

function CustomNode({ id, data, selected }) {
  const { nodeType = 'decisionTableNode', name = id, onDelete, onEdit, summary, content = {} } = data;
  const cfg = themedNodeConfig(getNodeConfig(nodeType));
  const updateInternals = useUpdateNodeInternals();
  const branches = nodeType === 'switchNode' ? JSON.stringify(content.statements || []) : '';
  useEffect(() => { updateInternals(id); }, [id, branches, updateInternals]);

  return (
    <div
      style={{
        backgroundColor: 'var(--cds-layer-02, #262626)',
        border: selected ? '2px solid var(--cds-focus, #0f62fe)' : '1px solid var(--cds-border-subtle, #393939)',
        borderLeft: `5px solid ${cfg.accentColor}`,
        borderRadius: '6px',
        minWidth: '220px',
        maxWidth: '300px',
        boxShadow: selected
          ? `0 0 0 2px var(--cds-focus, #0f62fe), 0 4px 16px rgba(15, 98, 254, 0.45)`
          : '0 3px 8px rgba(0,0,0,0.22)',
        transition: 'all 0.2s cubic-bezier(0.2, 0, 0.38, 0.9)',
        position: 'relative',
        color: 'var(--cds-text-primary, #f4f4f4)',
        overflow: 'hidden'
      }}
    >
      {/* Target Handle (Left) */}
      {nodeType !== 'inputNode' && (
        <Handle
          type="target"
          position={Position.Left}
          style={{
            background: cfg.handleColor,
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            border: '2px solid var(--cds-layer-01, #161616)',
            boxShadow: `0 0 6px ${cfg.handleColor}`
          }}
        />
      )}

      {/* Full Carbon Color Header */}
      <div
        className="decisions-node-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: cfg.headerBg,
          color: '#ffffff',
          borderBottom: '1px solid rgba(0,0,0,0.2)'
        }}
      >
        <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', color: '#ffffff' }}>
            {cfg.icon}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="decisions-node-eyebrow" style={{ opacity: 0.9 }}>
              {cfg.category}
            </span>
            <span className="decisions-type-heading-01">
              {cfg.label}
            </span>
          </div>
        </div>
        <div className="decisions-gap-01" style={{ display: 'flex' }}>
          {onEdit && (
            <Button
              hasIconOnly
              size="sm"
              kind="ghost"
              renderIcon={Settings}
              iconDescription="Edit Node"
              className="decisions-node-action"
              style={{ color: '#ffffff', width: '28px', height: '28px', minHeight: '28px' }}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(id);
              }}
            />
          )}
          {onDelete && (
            <Button
              hasIconOnly
              size="sm"
              kind="ghost"
              renderIcon={TrashCan}
              iconDescription="Delete Node"
              className="decisions-node-action"
              style={{ color: '#ffffff', width: '28px', height: '28px', minHeight: '28px' }}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(id);
              }}
            />
          )}
        </div>
      </div>

      {/* Node Body with Metadata */}
      <div className="decisions-node-body" style={{ backgroundColor: 'var(--cds-layer-02, #262626)' }}>
        <div className="decisions-mb-02" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="decisions-type-heading-01" style={{ color: 'var(--cds-text-primary, #f4f4f4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </div>
          <Tag type={cfg.tagType} size="sm" className="decisions-m-00 decisions-node-eyebrow">
            {nodeType.replace('Node', '')}
          </Tag>
        </div>
        <div className="decisions-type-label-01 decisions-gap-02" style={{ color: 'var(--cds-text-secondary, #c6c6c6)', display: 'flex', alignItems: 'center' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: cfg.accentColor, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summary || `${nodeType} definition`}
          </span>
        </div>
      </div>

      {/* Switch Branches (if switchNode) */}
      {nodeType === 'switchNode' && (
        <div className="decisions-node-branches" style={{ borderTop: '1px solid var(--cds-border-subtle, #393939)', backgroundColor: 'var(--cds-layer-01, #161616)' }}>
          {(content.statements || []).map(statement => (
            <div key={statement.id} className="decisions-type-label-01" style={{ position: 'relative', minHeight: '26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--cds-text-secondary, #c6c6c6)' }}>
              <span title={statement.condition || 'Fallback'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
                {statement.id}: {statement.condition || 'Fallback'}
              </span>
              <Handle
                id={statement.id}
                type="source"
                position={Position.Right}
                aria-label={`Branch ${statement.id}`}
                style={{
                  background: cfg.handleColor,
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  border: '2px solid var(--cds-layer-01, #161616)'
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Source Handle (Right) */}
      {nodeType !== 'outputNode' && nodeType !== 'switchNode' && (
        <Handle
          type="source"
          position={Position.Right}
          style={{
            background: cfg.handleColor,
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            border: '2px solid var(--cds-layer-01, #161616)',
            boxShadow: `0 0 6px ${cfg.handleColor}`
          }}
        />
      )}
    </div>
  );
}

export default memo(CustomNode);
