import React, { useEffect, useState } from 'react';
import { Accordion, AccordionItem, Button, Column, Grid, InlineLoading, InlineNotification, Select, SelectItem, Stack, Tag, TextArea, TextInput, Toggle } from '@carbon/react';
import { apiRequest } from '../config.js';
import { mergeProviderSettings } from '../decision-state.js';

const labels = { ikc: 'IBM Knowledge Catalog', wxdi: 'watsonx.data intelligence' };
const defaults = { enabled: false, base_url: '', version: '', catalog_id: '', api_profile: 'cpd_common_core_v2', asset_type: 'data_asset', auth_mode: 'api_key', username: '', ca_certificate: '', revision: 0, api_key: '', bearer_token: '' };

export default function AdminGovernanceSettings({ onSaved, defaultOpen = true }) {
  const [providers, setProviders] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [encrypted, setEncrypted] = useState(false);
  const load = async (signal, onlyProvider = null, keepDraft = false) => {
    setLoading(true);
    try {
      const data = await apiRequest('/admin/integrations', { signal });
      if (signal?.aborted) return;
      setProviders(previous => {
        const loaded = Object.fromEntries(Object.entries(data.providers).map(([id, value]) => [id, { ...defaults, ...value, api_key: '', bearer_token: '' }]));
        return mergeProviderSettings(previous, loaded, onlyProvider, keepDraft);
      });
      setEncrypted(data.encryption_available);
    } catch (cause) { if (!signal?.aborted) setError(cause.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  const edit = (id, field, value) => setProviders(previous => ({ ...previous, [id]: { ...previous[id], [field]: value } }));
  const save = async id => {
    setBusy(id); setError(null); setNotice(null);
    const settings = providers[id];
    try {
      const { enabled, base_url, version, catalog_id, api_profile, asset_type, auth_mode, username, ca_certificate, api_key, bearer_token } = settings;
      await apiRequest(`/admin/integrations/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, base_url, version, catalog_id, api_profile, asset_type, auth_mode, username, ca_certificate, api_key, bearer_token, expected_revision: settings.revision || 0 }) });
      await load(undefined, id);
      setNotice(`${labels[id]} settings saved. Test the saved connection before synchronizing a decision.`);
      onSaved?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(null); }
  };
  const test = async id => {
    setBusy(id); setError(null); setNotice(null);
    try {
      const result = await apiRequest(`/admin/integrations/${id}/test`, { method: 'POST' });
      await load(undefined, id, true);
      setNotice(`${labels[id]}: ${result.status}. ${result.catalog_count ?? 0} accessible catalogs returned by the saved connection.`);
      onSaved?.();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(null); }
  };
  return <Accordion><AccordionItem title="IBM Cloud Pak for Data (CP4D) & Catalog Integration Settings" open={defaultOpen}>
    <Stack gap={5}>
      <p className="cds--body-01">Configure each service with its own saved endpoint and credentials. Connection tests use saved settings. Saving configuration does not synchronize decision data.</p>
      {loading && <InlineLoading description="Loading saved integration settings…" />}
      {!loading && !encrypted && <InlineNotification kind="warning" title="Credential encryption unavailable" subtitle="The service needs secure credential storage before new connection credentials can be saved." hideCloseButton />}
      {error && <InlineNotification kind="error" title="Integration settings failed" subtitle={error} onCloseButtonClick={() => setError(null)} />}
      {notice && <InlineNotification kind="success" title="Integration settings" subtitle={notice} onCloseButtonClick={() => setNotice(null)} />}
      <Grid fullWidth>{Object.entries(labels).map(([id, label]) => {
        const value = providers[id];
        if (!value) return null;
        return <Column key={id} lg={8} md={8} sm={4}><Stack gap={5}>
          <h3 className="cds--productive-heading-03">{label}</h3>
          <Tag type={value.enabled ? 'blue' : 'cool-gray'}>{value.enabled ? 'Enabled' : 'Disabled'} · saved revision {value.revision}</Tag>
          <p className="cds--label-01">Last saved connection test: {value.last_test?.status || 'Not tested'}{value.last_test?.tested_at ? ` · ${new Date(value.last_test.tested_at).toLocaleString()}` : ''}</p>
          <Toggle id={`${id}-enabled`} labelText="Enable this integration" labelA="Disabled" labelB="Enabled" toggled={value.enabled} onToggle={enabled => edit(id, 'enabled', enabled)} disabled={Boolean(busy)} />
          <TextInput disabled={Boolean(busy)} id={`${id}-url`} labelText="Service URL" placeholder="https://your-service.example" value={value.base_url} onChange={event => edit(id, 'base_url', event.target.value)} />
          <TextInput disabled={Boolean(busy)} id={`${id}-version`} labelText="Installed service version" value={value.version} onChange={event => edit(id, 'version', event.target.value)} />
          <TextInput disabled={Boolean(busy)} id={`${id}-catalog`} labelText="Target catalog ID" value={value.catalog_id} onChange={event => edit(id, 'catalog_id', event.target.value)} />
          <Select disabled={Boolean(busy)} id={`${id}-asset-type`} labelText="Catalog Asset Type" value={value.asset_type || 'business_rule'} onChange={event => edit(id, 'asset_type', event.target.value)}>
            <SelectItem value="business_rule" text="Business Rule (business_rule)" />
            <SelectItem value="decision_service" text="Decision Service (decision_service)" />
            <SelectItem value="rule" text="Governance Rule (rule)" />
            <SelectItem value="data_asset" text="Data Asset (data_asset)" />
          </Select>
          <Select disabled={Boolean(busy)} id={`${id}-authentication`} labelText="Authentication" value={value.auth_mode} onChange={event => edit(id, 'auth_mode', event.target.value)}><SelectItem value="api_key" text="API key" /><SelectItem value="bearer" text="Bearer token" /></Select>
          <TextInput disabled={Boolean(busy)} id={`${id}-username`} labelText="Username" value={value.username} onChange={event => edit(id, 'username', event.target.value)} />
          <TextInput disabled={Boolean(busy)} id={`${id}-credential`} labelText={value.auth_mode === 'api_key' ? 'API key' : 'Bearer token'} type="password" autoComplete="new-password" value={value.auth_mode === 'api_key' ? value.api_key : value.bearer_token} helperText={value.credential_configured ? 'A credential is saved. Leave blank to keep it for the same endpoint and account.' : 'No credential is saved.'} onChange={event => edit(id, value.auth_mode === 'api_key' ? 'api_key' : 'bearer_token', event.target.value)} />
          <TextArea disabled={Boolean(busy)} id={`${id}-certificate`} labelText="Private CA certificate (optional PEM)" rows={3} value={value.ca_certificate || ''} onChange={event => edit(id, 'ca_certificate', event.target.value)} />
          <div className="decisions-actions"><Button size="sm" onClick={() => save(id)} disabled={Boolean(busy) || (!encrypted && Boolean(value.api_key || value.bearer_token))}>Save {label}</Button><Button size="sm" kind="tertiary" onClick={() => test(id)} disabled={Boolean(busy) || !value.revision}>Test saved connection</Button></div>
        </Stack></Column>;
      })}</Grid>
    </Stack>
  </AccordionItem></Accordion>;
}
