import React, { useState } from 'react';
import { Search, Tag, Button } from '@carbon/react';
import { ArrowLeft, Play, Table, Flow, Catalog, Code, Information, Compare } from '@carbon/icons-react';

const views = [['Simulator', Play], ['Decision table', Table], ['Visual editor', Flow], ['Catalog governance', Catalog], ['Expressions', Code], ['Audit logs', Information]];
export default function CarbonDocSidebar({ models, selectedModelKey, onSelectModel, activeTab, onSelectTab, onOpenDiff }) {
  const [query, setQuery] = useState('');
  const entries = Object.entries(models).filter(([id, model]) => `${id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
  const back = () => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem('buddy-welcome-seen', 'true');
      }
    } catch {}
    if (window.parent !== window) window.parent.postMessage({ type: 'DECISIONS_CLOSE' }, window.location.origin);
    else window.location.assign('/');
  };
  return <aside className="carbon-doc-sidebar" aria-label="Decisions navigation">
    <div className="sidebar-header-area"><h2 className="cds--productive-heading-02">Buddy Decisions</h2><Button size="sm" kind="ghost" renderIcon={ArrowLeft} onClick={back}>Back to Buddy</Button></div>
    <div className="sidebar-search-box"><Search id="decision-search" labelText="Find a decision" placeholder="Find a decision" value={query} onChange={event => setQuery(event.target.value)} size="sm" /></div>
    <nav aria-label="Decision models"><h3 className="sidebar-section-title">Decision models</h3><ul className="decisions-navigation-list">
      {entries.map(([id, model]) => <li key={id}><button type="button" className={`sidebar-nav-item ${id === selectedModelKey ? 'active' : ''}`} aria-current={id === selectedModelKey ? 'page' : undefined} onClick={() => onSelectModel(id)}><Flow size={16} /><span>{model.name || id}</span>{model._dirty && <Tag size="sm" type="cool-gray">Draft</Tag>}</button></li>)}
      {!entries.length && <li className="decisions-navigation-empty">{query ? 'No matching decisions' : 'No saved decisions'}</li>}
    </ul></nav>
    <nav aria-label="Workspace views"><h3 className="sidebar-section-title">Workspace</h3><ul className="decisions-navigation-list">{views.map(([label, Icon], index) => <li key={label}><button type="button" className={`sidebar-nav-item ${activeTab === index ? 'active' : ''}`} aria-current={activeTab === index ? 'page' : undefined} onClick={() => onSelectTab(index)}><Icon size={16} /><span>{label}</span></button></li>)}<li><button type="button" className="sidebar-nav-item" onClick={onOpenDiff} disabled={!models[selectedModelKey]?.version}><Compare size={16} /><span>Version history</span></button></li></ul></nav>
  </aside>;
}
