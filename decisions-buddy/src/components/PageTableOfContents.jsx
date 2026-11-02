import React from 'react';

export default function PageTableOfContents({ activeTab, currentModel }) {
  const getTocItems = () => {
    switch (activeTab) {
      case 1: // Decision Table
        return [
          { id: 'sec-overview', label: 'Decision Overview' },
          { id: 'sec-hit-policy', label: 'Hit Policy & Strategy' },
          { id: 'sec-rule-grid', label: 'Interactive Rule Grid' },
          { id: 'sec-heatmap', label: 'Rule Execution Heatmap' },
          { id: 'sec-diagnostics', label: 'Static Conflict Diagnostics' },
          { id: 'sec-policy-doc', label: 'Declarative .policy View' }
        ];
      case 3: // CP4D Governance
        return [
          { id: 'sec-ikc-asset', label: 'IKC Catalog Asset' },
          { id: 'sec-compliance', label: 'GDPR & BCBS 239 Scorecard' },
          { id: 'sec-glossary', label: 'Business Glossary Mapping' },
          { id: 'sec-lineage-flow', label: 'Lineage Architecture' },
          { id: 'sec-openlineage', label: 'OpenLineage Manifest' }
        ];
      case 2: // Visual Flow
        return [
          { id: 'sec-canvas', label: 'Visual Graph Canvas' },
          { id: 'sec-palette', label: 'Decision Task Palette' },
          { id: 'sec-wiring', label: 'Directed Edge Routing' }
        ];
      case 0: // Simulator
      default:
        return [
          { id: 'sec-input', label: 'Input JSON Payload' },
          { id: 'sec-execution', label: 'Engine DAG Execution' },
          { id: 'sec-performance', label: 'Microsecond Performance' },
          { id: 'sec-trace', label: 'Unary Rule Trace' }
        ];
    }
  };

  const items = getTocItems();

  return (
    <aside className="carbon-doc-toc" aria-label="On this page navigation">
      <div className="toc-title">On this page</div>
      <div>
        {items.map((item, idx) => (
          <button
            type="button"
            key={item.id}
            className={`toc-item ${idx === 0 ? 'active' : ''}`}
            onClick={() => {
              // Smooth scroll to top of content or focus
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </aside>
  );
}
