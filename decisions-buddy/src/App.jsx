import React, { useState, useEffect, useRef } from 'react';
import { Theme, Tabs, TabList, Tab, TabPanels, TabPanel, InlineNotification,
  Button, Modal, TextInput, InlineLoading, Stack, Tag } from '@carbon/react';
import { Play, Table, Flow, Code, DocumentExport, DocumentImport, Information, Catalog, Add, Renew, Save, Bot } from '@carbon/icons-react';
import HeaderBar from './components/HeaderBar.jsx';
import CarbonDocSidebar from './components/CarbonDocSidebar.jsx';
import SimulatorTab from './components/SimulatorTab.jsx';
import DecisionTableTab from './components/DecisionTableTab.jsx';
import VisualGraphEditor from './components/canvas/VisualGraphEditor.jsx';
import ReplTab from './components/ReplTab.jsx';
import AuditLogsTab from './components/AuditLogsTab.jsx';
import CP4DGovernanceTab from './components/CP4DGovernanceTab.jsx';
import VersionDiffModal from './components/VersionDiffModal.jsx';
import AdminGovernanceSettings from './components/AdminGovernanceSettings.jsx';
import BobFlowDesigner from './components/BobFlowDesigner.jsx';
import { SAMPLE_DECISION_MODELS } from './engine/sample-decisions.js';
import { apiRequest } from './config.js';
import { mergeSavedModels, savePayload, canEdit, newDraft, applySavedModel, savedModelsChanged } from './decision-state.js';
import './styles/main.scss';
import { downloadJson } from './lib/downloadJson.js';

export default function App() {
  const [theme, setTheme] = useState('white');
  const [activeTabIndex, setActiveTabIndex] = useState(1);
  const [models, setModels] = useState({});
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [evalError, setEvalError] = useState(null);
  const [successNotice, setSuccessNotice] = useState(null);
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 800);
  const [currentUser, setCurrentUser] = useState(null);
  const [promotionTarget, setPromotionTarget] = useState(null);
  const [isPromoting, setIsPromoting] = useState(false);
  const [integrationRevision, setIntegrationRevision] = useState(0);
  const [isBobDesignerOpen, setIsBobDesignerOpen] = useState(false);
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [remoteNotice, setRemoteNotice] = useState(null);
  const fileInput = useRef(null);
  const requestId = useRef(0);
  const savedSnapshots = useRef({});
  const pendingSave = useRef(null);
  const refreshId = useRef(0);
  const selectedId = useRef(selectedModelKey);
  selectedId.current = selectedModelKey;

  const fetchBackendModels = async ({ signal, notifyRemote = false } = {}) => {
    if (pendingSave.current) await pendingSave.current;
    if (signal?.aborted) return;
    const sequence = ++refreshId.current;
    setIsRefreshing(true);
    try {
      const user = await apiRequest('/me', { signal });
      if (signal?.aborted) return;
      setCurrentUser(user);
      const list = await apiRequest('/models', { signal });
      const entries = await Promise.all(list.map(async entry => [entry.id,
        await apiRequest(`/models/${encodeURIComponent(entry.id)}`, { signal })]));
      if (signal?.aborted) return;
      if (sequence !== refreshId.current) return;
      const loaded = Object.fromEntries(entries);
      if (notifyRemote && savedModelsChanged(savedSnapshots.current, loaded)) {
        setRemoteNotice('Saved decisions changed in another session. Your unsaved drafts are preserved.');
      }
      savedSnapshots.current = loaded;
      setModels(previous => mergeSavedModels(previous, loaded));
      setSelectedModelKey(previous => previous || entries[0]?.[0] || '');
      setBackendConnected(true);
    } catch (error) {
      if (!signal?.aborted && sequence === refreshId.current) { setBackendConnected(false); setEvalError(error.message); }
    } finally { if (!signal?.aborted && sequence === refreshId.current) setIsRefreshing(false); }
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetchBackendModels({ signal: controller.signal });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isUnmounted = false;

    const connectWs = () => {
      if (isUnmounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/decisions/ws`;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setIsLiveConnected(false);
        reconnectTimer = setTimeout(connectWs, 3000);
        return;
      }

      ws.onopen = () => {
        if (!isUnmounted) setIsLiveConnected(true);
      };

      ws.onmessage = event => {
        if (isUnmounted) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'models_changed') {
            // Model content is fetched under this session's read permissions;
            // websocket invalidations never contain another user's private data.
            void fetchBackendModels({ notifyRemote: true });
          }
        } catch {
          // Keepalive or binary frame ignore
        }
      };

      ws.onclose = () => {
        if (!isUnmounted) {
          setIsLiveConnected(false);
          reconnectTimer = setTimeout(connectWs, 3000);
        }
      };

      ws.onerror = () => {
        if (!isUnmounted) {
          setIsLiveConnected(false);
          try { ws.close(); } catch {}
        }
      };
    };

    connectWs();

    return () => {
      isUnmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try { ws.close(); } catch {}
      }
    };
  }, []);

  useEffect(() => {
    const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;
    if (isEmbedded) {
      document.documentElement.style.setProperty('--ui-scale', '1');
      document.documentElement.style.zoom = '1';
    } else {
      const handleScaleMessage = event => {
        if (event.origin !== window.location.origin || event.source !== window) return;
        if (event.data?.type === 'SET_UI_SCALE' && Number.isFinite(event.data.scale)
            && event.data.scale >= 0.5 && event.data.scale <= 2) {
          document.documentElement.style.setProperty('--ui-scale', String(event.data.scale));
          document.documentElement.style.zoom = String(event.data.scale);
        }
      };
      window.addEventListener('message', handleScaleMessage);
      const params = new URLSearchParams(window.location.search);
      const scaleParam = Number(params.get('scale'));
      if (Number.isFinite(scaleParam) && scaleParam >= 0.5 && scaleParam <= 2) {
        document.documentElement.style.setProperty('--ui-scale', String(scaleParam));
        document.documentElement.style.zoom = String(scaleParam);
      }
      return () => window.removeEventListener('message', handleScaleMessage);
    }
  }, []);

  useEffect(() => {
    const allowed = new Set(['--workspace-canvas', '--toolbar-background', '--toolbar-border',
      '--toolbar-text', '--toolbar-control', '--toolbar-hover', '--toolbar-selected',
      '--buddy-sidebar-background', '--sidebar-card-background', '--sidebar-border',
      '--sidebar-text', '--sidebar-secondary']);
    const receiveChrome = event => {
      if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin
          || event.data?.type !== 'BUDDY_CHROME_THEME' || !event.data.colors
          || typeof event.data.colors !== 'object') return;
      for (const [name, value] of Object.entries(event.data.colors)) {
        if (allowed.has(name) && typeof value === 'string' && value.length < 128 && CSS.supports('color', value)) {
          document.documentElement.style.setProperty(name, value);
        }
      }
    };
    window.addEventListener('message', receiveChrome);
    if (window.parent !== window) window.parent.postMessage({ type: 'BUDDY_CHROME_READY' }, window.location.origin);
    return () => window.removeEventListener('message', receiveChrome);
  }, []);

  const currentModel = models[selectedModelKey];
  const editable = canEdit(currentModel, currentUser);
  const canAuthor = Boolean(currentUser?.isAdmin || currentUser?.canAuthor);
  useEffect(() => {
    setInputJson(JSON.stringify(models[selectedModelKey]?.defaultInput || {}, null, 2));
    setEvaluationResult(null); setIsLoading(false);
    requestId.current += 1;
  }, [selectedModelKey]);

  useEffect(() => {
    const warn = event => {
      if (Object.values(models).some(model => model._dirty)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [models]);

  const handleEvaluate = async (customModel = null, { savedVersion = false } = {}) => {
    const model = customModel || currentModel;
    if (!model || !backendConnected) { setEvalError('Connect to the decision service before evaluating.'); return; }
    const sequence = ++requestId.current;
    const modelId = selectedModelKey;
    setIsLoading(true); setEvalError(null); setEvaluationResult(null);
    try {
      const input = JSON.parse(inputJson);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object.');
      const payload = model._dirty || !model.version || (customModel && !savedVersion)
        ? { graph: model.graph, input } : { decisionId: model.id, expectedVersion: model.version, input };
      const data = await apiRequest('/evaluate', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (sequence === requestId.current && modelId === selectedId.current) { setEvaluationResult(data); return data; }
    } catch (error) {
      if (sequence === requestId.current) setEvalError(error.message);
    } finally { if (sequence === requestId.current) setIsLoading(false); }
  };

  const handleUpdateModel = updated => {
    if (!editable) return;
    setModels(previous => ({ ...previous, [selectedModelKey]: { ...updated, _dirty: true } }));
    requestId.current += 1; setEvaluationResult(null); setIsLoading(false);
  };

  const handleSaveToDb = async model => {
    if (!backendConnected || !canEdit(model, currentUser) || pendingSave.current) return null;
    let releaseSave;
    pendingSave.current = new Promise(resolve => { releaseSave = resolve; });
    refreshId.current += 1;
    setIsSaving(true); setEvalError(null); setRemoteNotice(null);
    try {
      const data = await apiRequest('/models', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savePayload(model)) });
      savedSnapshots.current = { ...savedSnapshots.current, [model.id]: data.decision };
      setModels(previous => ({ ...previous, [model.id]: applySavedModel(previous[model.id], model, data.decision) }));
      setSuccessNotice(`Saved ${data.decision.name}, version ${data.decision.version}.`);
      return data.decision;
    } catch (error) { setEvalError(error.message); }
    finally { setIsSaving(false); setIsRefreshing(false); pendingSave.current = null; releaseSave(); }
  };

  const handleSaveAndEvaluate = async model => {
    const saved = await handleSaveToDb(model);
    if (saved && selectedId.current === model.id) {
      const result = await handleEvaluate(saved, { savedVersion: true });
      if (result) setSuccessNotice(`Saved and ran ${saved.name}, version ${saved.version}.`);
    }
  };

  const handleApplyBobFlow = ({ name, description, graph, defaultInput }) => {
    const key = selectedModelKey || `draft-${Date.now()}`;
    const base = models[key] || newDraft(key);
    const updated = {
      ...base,
      name: name || base.name,
      description: description || base.description,
      graph,
      defaultInput: defaultInput ?? base.defaultInput,
      _dirty: true
    };
    setModels(previous => ({ ...previous, [key]: updated }));
    if (!selectedModelKey) setSelectedModelKey(key);
    if (defaultInput) {
      setInputJson(JSON.stringify(defaultInput, null, 2));
    }
    setActiveTabIndex(2);
    setSuccessNotice(`Bob applied "${name || 'flow'}". Evaluate or inspect in the visual editor.`);
  };

  const handlePromoteGovernance = () => {
    if (!currentModel?.version || currentModel._dirty) { setEvalError('Save this draft before requesting a governance transition.'); return; }
    const stages = { draft: 'in_review', in_review: 'approved', approved: 'published', published: 'draft' };
    const status = stages[currentModel.status] || 'in_review';
    setPromotionTarget({ id: currentModel.id, name: currentModel.name,
      expectedVersion: currentModel.version, status,
      environment: status === 'published' ? 'production' : status === 'approved' ? 'staging' : 'development' });
  };

  const confirmPromotion = async () => {
    if (!promotionTarget || isPromoting) return;
    setIsPromoting(true); setEvalError(null);
    try {
      const result = await apiRequest(`/models/${encodeURIComponent(promotionTarget.id)}/governance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: promotionTarget.status, environment: promotionTarget.environment, expectedVersion: promotionTarget.expectedVersion }) });
      const saved = result.decision || result;
      if (saved.id) setModels(previous => ({ ...previous, [saved.id]: saved }));
      else await fetchBackendModels();
      setPromotionTarget(null);
      setSuccessNotice('The requested governance transition was recorded.');
    } catch (error) { setEvalError(error.message); }
    finally { setIsPromoting(false); }
  };

  const addDraft = model => { setModels(previous => ({ ...previous, [model.id]: model })); setSelectedModelKey(model.id); };
  const createDraft = () => addDraft(newDraft(`decision-${crypto.randomUUID()}`));
  const createExample = () => {
    const example = structuredClone(Object.values(SAMPLE_DECISION_MODELS)[0]);
    addDraft({ ...example, id: `example-${crypto.randomUUID()}`, name: `${example.name} (example draft)`,
      description: 'Fictional example for learning. Review and save explicitly to retain it.',
      version: undefined, accessPolicy: 'private', status: 'draft', environment: 'development', _dirty: true });
  };
  const handleImportDecisionModel = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a JSON file smaller than 1 MB.');
      const parsed = JSON.parse(await file.text());
      const graph = parsed.nodes ? parsed : parsed.graph;
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('The file must contain a decision graph with nodes and edges.');
      addDraft({ ...newDraft(`import-${crypto.randomUUID()}`), name: file.name.replace(/\.json$/, ''), graph,
        description: 'Imported draft. Review its rules before evaluating or saving.' });
    } catch (error) { setEvalError(error.message); }
  };
  const handleExportDecisionModel = () => {
    if (!currentModel) return;
    downloadJson(currentModel.graph, `${currentModel.id}.json`);
  };

  return <Theme theme={theme}><div className="decisions-app-container">
    <HeaderBar theme={theme} toggleTheme={() => setTheme(value => value === 'white' ? 'g100' : 'white')}
      backendConnected={backendConnected} isLiveConnected={isLiveConnected} currentModel={currentModel} currentUser={currentUser}
      onOpenDiff={() => setIsDiffModalOpen(true)} onPromoteGovernance={handlePromoteGovernance}
      isSidebarOpen={isSidebarOpen} onToggleSidebar={() => setIsSidebarOpen(value => !value)} />
    <div className="carbon-doc-shell">
      {isSidebarOpen && <CarbonDocSidebar models={models} selectedModelKey={selectedModelKey}
        onSelectModel={id => { setSelectedModelKey(id); if (window.innerWidth < 800) setIsSidebarOpen(false); }} activeTab={activeTabIndex} onSelectTab={setActiveTabIndex}
        onOpenDiff={() => setIsDiffModalOpen(true)} />}
      <main id="decision-main-content" tabIndex={-1} className="carbon-doc-center">
        <Stack gap={5}>
          <div><h1 className="cds--productive-heading-05">{currentModel?.name || 'Decisions'}</h1>
            <p className="carbon-page-subtitle">{currentModel ? currentModel._dirty ? 'Unsaved draft · changes are kept while this workspace remains open' : `Version ${currentModel.version} · ${currentModel.updatedAt ? new Date(currentModel.updatedAt).toLocaleString() : 'Saved decision'}` : 'Create, evaluate and review business decision rules.'}</p>
            {currentModel?.description && <p className="cds--body-01">{currentModel.description}</p>}
          </div>
          <div className="decisions-actions">
            <Button size="sm" renderIcon={Add} onClick={createDraft} disabled={!canAuthor}>New decision</Button>
            <Button size="sm" kind="tertiary" renderIcon={Bot} onClick={() => setIsBobDesignerOpen(true)} disabled={!canAuthor}>Design with Bob</Button>
            <Button size="sm" kind="tertiary" renderIcon={DocumentImport} onClick={() => fileInput.current?.click()} disabled={!canAuthor}>Import Model</Button>
            <input ref={fileInput} className="decisions-file-input" type="file" accept=".json,application/json" aria-label="Import a decision JSON file" onChange={handleImportDecisionModel} />
            <Button size="sm" kind="ghost" renderIcon={DocumentExport} onClick={handleExportDecisionModel} disabled={!currentModel}>Export Model</Button>
            <Button size="sm" kind="ghost" renderIcon={Renew} onClick={() => fetchBackendModels()} disabled={isRefreshing || isSaving}>Refresh saved models</Button>
            <Button size="sm" kind="ghost" onClick={createExample} disabled={!canAuthor}>Load example draft</Button>
            {editable && <Button size="sm" renderIcon={Save} onClick={() => handleSaveToDb(currentModel)} disabled={!backendConnected || isSaving || !currentModel._dirty}>{isSaving ? 'Saving…' : 'Save decision'}</Button>}
          </div>
          {isRefreshing && <InlineLoading description="Loading saved decisions…" />}
          {successNotice && <InlineNotification kind="success" title="Saved" subtitle={successNotice} onCloseButtonClick={() => setSuccessNotice(null)} />}
          {remoteNotice && <InlineNotification kind="warning" title="Remote update" subtitle={remoteNotice} onCloseButtonClick={() => setRemoteNotice(null)} />}
          {evalError && <InlineNotification kind="error" title="Decision service request failed" subtitle={evalError} onCloseButtonClick={() => setEvalError(null)} />}
          {!currentModel && !isRefreshing && <section className="decisions-empty-state"><h2 className="cds--productive-heading-03">No decision selected</h2><p className="cds--body-01">Choose a saved model, create a decision, or import a JSON decision graph. Example drafts are fictional and are saved only when you choose Save.</p></section>}
          {currentModel && <>
            {editable && <TextInput id="decision-name" labelText="Decision name" value={currentModel.name} maxLength={200} onChange={event => handleUpdateModel({ ...currentModel, name: event.target.value })} />}
            {!editable && <Tag type="cool-gray">Read-only · owned by {currentModel.owner}</Tag>}
            <Tabs selectedIndex={activeTabIndex} onChange={({ selectedIndex }) => setActiveTabIndex(selectedIndex)}>
              <TabList aria-label="Decision workspace views"><Tab renderIcon={Play}>Simulator</Tab><Tab renderIcon={Table}>Decision table</Tab><Tab renderIcon={Flow}>Visual editor</Tab><Tab renderIcon={Catalog}>Catalog governance</Tab><Tab renderIcon={Code}>Expressions</Tab><Tab renderIcon={Information}>Audit logs</Tab></TabList>
              <TabPanels>
                <TabPanel><SimulatorTab editable={editable} selectedModelKey={selectedModelKey} setSelectedModelKey={setSelectedModelKey} models={models} inputJson={inputJson} setInputJson={setInputJson} onEvaluate={() => handleEvaluate()} evaluationResult={evaluationResult} isLoading={isLoading} backendConnected={backendConnected} /></TabPanel>
                <TabPanel><DecisionTableTab key={selectedModelKey} editable={editable} model={currentModel} onUpdateModel={handleUpdateModel} onEvaluate={() => handleEvaluate()} onSaveToDb={editable ? handleSaveToDb : undefined} evaluationResult={evaluationResult} /></TabPanel>
                <TabPanel><VisualGraphEditor key={selectedModelKey} editable={editable} active={activeTabIndex === 2} model={currentModel} onSaveGraph={handleUpdateModel} onSaveAndRun={editable ? handleSaveAndEvaluate : undefined} onEvaluate={handleEvaluate} evaluationResult={evaluationResult} isBusy={isSaving || isLoading} onShowResults={() => setActiveTabIndex(0)} onOpenBobDesigner={() => setIsBobDesignerOpen(true)} /></TabPanel>
                <TabPanel><CP4DGovernanceTab key={selectedModelKey} model={currentModel} backendConnected={backendConnected} currentUser={currentUser} integrationRevision={integrationRevision} onGovernanceChanged={fetchBackendModels} /></TabPanel>
                <TabPanel><ReplTab backendConnected={backendConnected} /></TabPanel>
                <TabPanel><AuditLogsTab backendConnected={backendConnected} /></TabPanel>
              </TabPanels>
            </Tabs>
          </>}
        </Stack>
      </main>
    </div>
    <VersionDiffModal isOpen={isDiffModalOpen} onClose={() => setIsDiffModalOpen(false)} decisionId={currentModel?.version ? currentModel.id : null} expectedVersion={currentModel?.version} canRollback={editable && !currentModel?._dirty} onRollbackSuccess={fetchBackendModels} />
    <Modal open={Boolean(promotionTarget)} danger={promotionTarget?.status === 'published'} modalHeading="Confirm governance transition" primaryButtonText={isPromoting ? 'Recording…' : 'Confirm transition'} secondaryButtonText="Cancel" primaryButtonDisabled={isPromoting} onRequestClose={() => !isPromoting && setPromotionTarget(null)} onRequestSubmit={confirmPromotion}>
      <p>Decision: {promotionTarget?.name}. Version: {promotionTarget?.expectedVersion}.</p><p>Requested stage: {promotionTarget?.status}. Environment: {promotionTarget?.environment}. The service will validate your permissions and any independent approval requirement.</p>
    </Modal>
    <BobFlowDesigner isOpen={isBobDesignerOpen} onClose={() => setIsBobDesignerOpen(false)} onApplyFlow={handleApplyBobFlow} currentGraph={currentModel?.graph} />
  </div></Theme>;
}
