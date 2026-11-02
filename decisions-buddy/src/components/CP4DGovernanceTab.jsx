import React, { useEffect, useState } from 'react';
import { Accordion, AccordionItem, Button, CodeSnippet, InlineLoading, InlineNotification, Modal, Select, SelectItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { apiRequest } from '../config.js';
import AdminGovernanceSettings from './AdminGovernanceSettings.jsx';


export default function CP4DGovernanceTab({ model, backendConnected, currentUser, integrationRevision = 0, onGovernanceChanged }) {
  const [provider, setProvider] = useState('ikc');
  const [status, setStatus] = useState(null);
  const [governance, setGovernance] = useState(null);
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [metadataPreview, setMetadataPreview] = useState(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);

  const connectorUrl = model?.id
    ? `${window.location.origin}/api/decisions/models/${encodeURIComponent(model.id)}/metadata`
    : '';
  const openapiUrl = model?.id
    ? `${window.location.origin}/api/decisions/models/${encodeURIComponent(model.id)}/openapi.json`
    : '';

  const loadMetadataPreview = async () => {
    if (!model?.id) return;
    setLoadingMetadata(true);
    try {
      const data = await apiRequest(`/models/${encodeURIComponent(model.id)}/metadata`);
      setMetadataPreview(data);
    } catch (err) {
      setError(`Failed to fetch metadata contract: ${err.message}`);
    } finally {
      setLoadingMetadata(false);
    }
  };
  const reload = async signal => {
    if (!backendConnected) return;
    setLoading(true); setError(null);
    try {
      const connection = await apiRequest('/cp4d/status', { signal });
      if (signal?.aborted) return;
      setStatus(connection);
      if (model?.id && model?.version) {
        const record = await apiRequest(`/cp4d/governance/${encodeURIComponent(model.id)}?provider=${provider}`, { signal });
        if (signal?.aborted) return;
        setGovernance(record);
      } else {
        setGovernance(null);
      }
      if (connection.providers?.[provider]?.configured) {
        const list = await apiRequest(`/cp4d/terms?provider=${provider}`, { signal });
        if (!signal?.aborted) setTerms(list);
      } else setTerms([]);
    } catch (cause) { if (!signal?.aborted) setError(cause.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => { setStatus(null); setGovernance(null); setTerms([]); const controller = new AbortController(); void reload(controller.signal); return () => controller.abort(); }, [model?.id, model?.version, backendConnected, provider, integrationRevision]);
  const synchronize = async () => {
    setBusy(true); setError(null);
    try {
      const result = await apiRequest(`/cp4d/sync/${encodeURIComponent(model.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: model.version }) });
      setNotice(result.message || 'The catalog synchronization completed.'); setConfirmSync(false); await reload(); await onGovernanceChanged?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const mappings = Object.entries(governance?.termMappings || {});
  const editable = Boolean(currentUser && model && (currentUser.isAdmin || currentUser.canAuthor && model.owner === currentUser.username));
  const enabled = Object.entries(status?.providers || {}).filter(([, settings]) => settings.enabled);
  const selectedConnection = status?.providers?.[provider];
  const syncReady = enabled.length > 0 && enabled.every(([, settings]) => settings.configured && settings.catalogId);
  const assignTerm = async (field, termId) => {
    if (!termId || !editable || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await apiRequest(`/cp4d/governance/${encodeURIComponent(model.id)}/map-term`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, termId, provider, expectedVersion: model.version }),
      });
      setGovernance(previous => ({ ...previous, termMappings: result.termMappings, syncStatus: 'stale' }));
      setNotice('The term mapping was verified against the selected service and saved. Synchronize again before production approval.');
      await onGovernanceChanged?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <Stack gap={6}>
    <section className="decisions-governance-overview">
      <h2 className="cds--productive-heading-03">IBM Cloud Pak for Data (CP4D) Data Governance & Catalog</h2>
      <p className="cds--body-01">
        Configure the CP4D service connection, test access to IBM Knowledge Catalog (IKC) or watsonx.data intelligence (wxdi), map decision inputs/outputs to enterprise glossary terms, and synchronize metadata and data lineage.
      </p>
    </section>

    {/* Section 1: CP4D HTTP Connector & Metadata Harvest */}
    <section aria-label="CP4D HTTP Connector">
      <h3 className="cds--productive-heading-02 decisions-mb-02">1. CP4D HTTP Connector & Metadata Harvest</h3>
      <p className="cds--body-01 decisions-mb-03">
        Register this decision service as a <strong>Generic REST Connection</strong> in CP4D (<code>Data &gt; Platform connections</code>). CP4D Metadata Import (MDI) queries this read-only contract to harvest decision schemas, input/output structures, and watsonx dependencies without executing rules or gating lifecycle decisions.
      </p>

      <div className="decisions-mb-04 decisions-gap-03" style={{ display: 'flex', flexDirection: 'column' }}>
        <div>
          <span className="cds--label-01">CP4D Metadata Harvest URL (Read-only Schema &amp; Contract):</span>
          <div className="decisions-mt-02 decisions-gap-03" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
            <CodeSnippet type="single" feedback="Copied to clipboard">
              {connectorUrl || 'Save decision to generate connector URL'}
            </CodeSnippet>
            <Button
              size="sm"
              kind="tertiary"
              onClick={loadMetadataPreview}
              disabled={!model?.id || loadingMetadata}
            >
              {loadingMetadata ? 'Fetching…' : 'Inspect Harvest Contract'}
            </Button>
          </div>
        </div>

        {metadataPreview && (
          <Accordion>
            <AccordionItem title="CP4D Harvestable Metadata & OpenAPI 3.0 Contract (Live Preview)" open>
              <CodeSnippet type="multi" feedback="Copied to clipboard">
                {JSON.stringify(metadataPreview, null, 2)}
              </CodeSnippet>
            </AccordionItem>
          </Accordion>
        )}
      </div>
    </section>

    {/* Section 2: CP4D Service Connection Setup & Diagnostics */}
    <section aria-label="CP4D Connection Setup">
      <h3 className="cds--productive-heading-02 decisions-mb-02">2. CP4D Direct Push Connection (Optional)</h3>
      <p className="cds--body-01 decisions-mb-04">
        Optionally enter your CP4D endpoint, credentials, and target catalog to push synchronized decision governance records directly into IBM Knowledge Catalog.
      </p>
      {Boolean(currentUser?.isAdmin) && <AdminGovernanceSettings defaultOpen={true} onSaved={() => { void reload(); onGovernanceChanged?.(); }} />}
    </section>

    {/* Section 3: Active Catalog Governance & Glossary Mapping */}
    <section aria-label="Catalog Governance and Business Terms">
      <h3 className="cds--productive-heading-02 decisions-mb-02">3. Catalog Governance & Glossary Term Mapping (Optional)</h3>
      <div className="decisions-mt-03 decisions-mb-03" style={{ display: 'flex', alignItems: 'center' }}>
        <Select id="decision-governance-provider" labelText="Selected catalog service" value={provider} onChange={event => setProvider(event.target.value)}>
          <SelectItem value="ikc" text="IBM Knowledge Catalog (IKC)" />
          <SelectItem value="wxdi" text="watsonx.data intelligence (wxdi)" />
        </Select>
      </div>

      {!model?.version && <InlineNotification kind="info" title="Draft decision" subtitle="Catalog governance and lineage synchronization apply to a saved version. Save this decision draft to record permanent governance evidence." hideCloseButton />}
      {governance && <Tag type={governance.syncStatus === 'synced' ? 'green' : 'cool-gray'}>Recorded synchronization: {governance.syncStatus}{governance.syncedVersion ? ` · version ${governance.syncedVersion}` : ''}</Tag>}
      {loading && <InlineLoading description="Loading catalog configuration and recorded governance…" />}
      {status && <Tag type={selectedConnection?.configured ? 'blue' : 'cool-gray'}>{selectedConnection?.configured ? 'Selected connection configured' : 'Selected connection not configured'}</Tag>}
      {status && !selectedConnection?.configured && <InlineNotification kind="info" title="No live catalog connection" subtitle="Configure and test the service above. No live catalogs, glossary terms, or compliance status are assumed." hideCloseButton />}
      {error && <InlineNotification kind="error" title="Catalog request failed" subtitle={error} onCloseButtonClick={() => setError(null)} />}
      {notice && <InlineNotification kind="success" title="Catalog synchronization" subtitle={notice} onCloseButtonClick={() => setNotice(null)} />}
    </section>

    {/* Section 3: Synchronization & Lineage Manifest */}
    {enabled.length > 0 && <p className="cds--body-01">Synchronization uses every enabled service and its saved catalog: {enabled.map(([name, settings]) => `${name === 'ikc' ? 'IBM Knowledge Catalog' : 'watsonx.data intelligence'} (${settings.catalogId || 'no catalog configured'})`).join('; ')}.</p>}
    <Button size="sm" onClick={() => setConfirmSync(true)} disabled={!syncReady || !editable || !model?.version || model._dirty || loading || busy}>Review catalog synchronization</Button>
    <TableContainer title="Recorded field mappings" description="Each input and output field must be linked to an active business term before production approval. Choose the term source above. Mappings are metadata, not legal certifications."><Table size="md"><TableHead><TableRow><TableHeader>Field</TableHeader><TableHeader>Role</TableHeader><TableHeader>Current term</TableHeader><TableHeader>Verification</TableHeader><TableHeader>Assign term from selected service</TableHeader></TableRow></TableHead><TableBody>{mappings.length ? mappings.map(([field, mapping]) => <TableRow key={field}><TableCell>{mapping.field}</TableCell><TableCell>{mapping.type}</TableCell><TableCell>{mapping.termName || 'Unmapped'}{mapping.provider ? ` (${mapping.provider})` : ''}</TableCell><TableCell>{mapping.verification === 'active_remote_term' ? 'Active term verified' : 'Not verified'}</TableCell><TableCell><Select id={`decision-term-${encodeURIComponent(field)}`} labelText={`Business term for ${mapping.type} ${mapping.field}`} hideLabel size="sm" value={mapping.provider === provider && terms.some(term => term.id === mapping.termId) ? mapping.termId : ''} disabled={!editable || model._dirty || !selectedConnection?.configured || busy || loading || !terms.length} onChange={event => assignTerm(field, event.target.value)}><SelectItem value="" text={terms.length ? 'Choose a business term' : 'No terms available'} />{terms.map(term => <SelectItem key={term.id} value={term.id} text={term.name || term.id} />)}</Select></TableCell></TableRow>) : <TableRow><TableCell colSpan={5}>No field mappings are recorded for this graph.</TableCell></TableRow>}</TableBody></Table></TableContainer>
    <Accordion><AccordionItem title="Recorded lineage manifest"><CodeSnippet type="multi">{JSON.stringify(governance?.lineageManifest || {}, null, 2)}</CodeSnippet></AccordionItem></Accordion>
    <Modal open={confirmSync} modalHeading="Confirm catalog synchronization" primaryButtonText={busy ? 'Synchronizing…' : 'Synchronize saved version'} secondaryButtonText="Cancel" primaryButtonDisabled={busy} onRequestClose={() => !busy && setConfirmSync(false)} onRequestSubmit={synchronize}><p>Send decision metadata for {model?.name}, saved version {model?.version}, to every enabled service: {enabled.map(([name, settings]) => `${name === 'ikc' ? 'IBM Knowledge Catalog' : 'watsonx.data intelligence'} at ${settings.origin}, catalog ${settings.catalogId}`).join('; ')}.</p><p>The service validates authorization, terms and version before sending data. This registers decision metadata; it does not ingest lineage into Manta or establish regulatory compliance. Unsaved edits are excluded.</p></Modal>
  </Stack>;
}
