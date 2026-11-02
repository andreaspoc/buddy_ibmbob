import { themeCssValue } from '../../../web/src/lib/themeColor.ts';
import React from 'react';
import { Tile, Tag } from '@carbon/react';
import { Flow, DecisionTree, Code, Bot, Analytics } from '@carbon/icons-react';

const getTaskMeta = (type) => {
  switch (type) {
    case 'inputNode':
      return { tagType: 'blue', category: 'Input Schema', accentColor: '#0f62fe', icon: <Flow size={20} /> };
    case 'decisionTableNode':
      return { tagType: 'purple', category: 'Rule Task', accentColor: themeCssValue('#8a3ffc'), icon: <DecisionTree size={20} /> };
    case 'watsonxAiNode':
      return { tagType: 'magenta', category: 'Generative AI', accentColor: '#ee5396', icon: <Bot size={20} /> };
    case 'watsonxMlNode':
      return { tagType: 'teal', category: 'Predictive ML', accentColor: '#007d79', icon: <Analytics size={20} /> };
    case 'expressionNode':
      return { tagType: 'cyan', category: 'Action Task', accentColor: '#1192e8', icon: <Code size={20} /> };
    case 'switchNode':
      return { tagType: 'warm-gray', category: 'Branch Gateway', accentColor: '#ff832b', icon: <Flow size={20} /> };
    case 'outputNode':
      return { tagType: 'green', category: 'Decision Outcome', accentColor: '#24a148', icon: <Flow size={20} /> };
    default:
      return { tagType: 'cool-gray', category: 'Decision Task', accentColor: '#697077', icon: <Flow size={20} /> };
  }
};

export default function GraphFlowTab({ model, evaluationResult }) {
  if (!model) return null;

  const nodes = model.graph.nodes || [];
  const edges = model.graph.edges || [];

  // Map execution durations from evaluation result
  const durationMap = {};
  if (evaluationResult?.trace) {
    evaluationResult.trace.forEach((t) => {
      durationMap[t.id] = t.durationMicros;
    });
  }

  return (
    <div className="decisions-mt-06" >
      <Tile className="decisions-mb-06" >
        <h4 className="decisions-type-heading-02 decisions-m-00-00-03-00" >Decision Flow Pipeline (DAG)</h4>
        <p className="decisions-type-body-compact-01 decisions-m-00" style={{ color: 'var(--cds-text-secondary)' }}>
          Visual representation of rule tables, calculation tasks, AI scoring models, and execution sequence.
        </p>
      </Tile>

      <div className="decisions-graph-canvas">
        <div className="decisions-pipeline-flow">
          {nodes.map((node, idx) => {
            const duration = durationMap[node.id];
            const hasRun = duration !== undefined;
            const meta = getTaskMeta(node.type);

            return (
              <React.Fragment key={node.id}>
                <div
                  className={`decisions-flow-node ${hasRun ? 'active-node' : ''}`}
                  style={{
                    borderLeft: `4px solid ${meta.accentColor}`,
                    boxShadow: hasRun ? `0 0 10px rgba(36, 161, 72, 0.3)` : '0 2px 6px rgba(0,0,0,0.15)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="node-type-title decisions-node-eyebrow">
                      {meta.category}
                    </span>
                    <span style={{ color: meta.accentColor }}>{meta.icon}</span>
                  </div>
                  <div className="node-name decisions-mt-02">{node.name}</div>
                  <div className="decisions-mt-03" >
                    <Tag type={meta.tagType} size="sm">
                      {node.type.replace('Node', '')}
                    </Tag>
                  </div>
                  <div className="node-duration">
                    {hasRun ? `Executed in ${duration} μs` : 'Pending execution'}
                  </div>
                </div>

                {idx < nodes.length - 1 && (
                  <div className="decisions-flow-arrow decisions-type-heading-02" style={{ color: 'var(--cds-interactive, #0f62fe)' }}>➔</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <Tile className="decisions-mt-06" >
        <h5 className="decisions-type-heading-02 decisions-mb-03" >Edges & Topological Dependency Graph</h5>
        <ul className="decisions-type-body-compact-01 decisions-pl-06 decisions-m-00" style={{ color: 'var(--cds-text-secondary)' }}>
          {edges.map((e) => (
            <li key={e.id} className="decisions-mb-02" >
              <code>{e.sourceId}</code> ➔ <code>{e.targetId}</code>
            </li>
          ))}
        </ul>
      </Tile>
    </div>
  );
}
