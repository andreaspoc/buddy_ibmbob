import React, { useState, useEffect } from 'react';
import { Modal, Select, SelectItem, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, Button, InlineNotification, InlineLoading, Stack, Grid, Column } from '@carbon/react';
import { apiRequest } from '../config.js';

export default function VersionDiffModal({ isOpen, onClose, decisionId, expectedVersion, canRollback = false, onRollbackSuccess }) {
  const [versions, setVersions] = useState([]);
  const [v1, setV1] = useState(0);
  const [v2, setV2] = useState(0);
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [rollbackTarget, setRollbackTarget] = useState(null);
  useEffect(() => {
    setRollbackTarget(null); setDiff(null); setError(null);
    if (!isOpen || !decisionId) return;
    const controller = new AbortController();
    setLoading(true); setVersions([]);
    apiRequest(`/models/${encodeURIComponent(decisionId)}/versions`, { signal: controller.signal })
      .then(list => { if (!controller.signal.aborted) { setVersions(list); setV1(list[1]?.version || list[0]?.version || 0); setV2(list[0]?.version || 0); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isOpen, decisionId]);
  useEffect(() => {
    if (!isOpen || !decisionId || !v1 || !v2 || !versions.length) return;
    const controller = new AbortController();
    setLoading(true);
    apiRequest(`/models/${encodeURIComponent(decisionId)}/diff?v1=${v1}&v2=${v2}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setDiff(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isOpen, decisionId, v1, v2, versions.length]);
  const rollback = async () => {
    if (!rollbackTarget || !canRollback || busy) return;
    setBusy(true); setError(null);
    try {
      await apiRequest(`/models/${encodeURIComponent(decisionId)}/rollback?version=${rollbackTarget}&expectedVersion=${expectedVersion}`, { method: 'POST' });
      await onRollbackSuccess?.();
      setRollbackTarget(null); onClose();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const close = () => { if (!busy) { if (rollbackTarget) setRollbackTarget(null); else onClose(); } };
  return <Modal open={isOpen} onRequestClose={close} passiveModal={!rollbackTarget} danger={Boolean(rollbackTarget)} onRequestSubmit={rollback} primaryButtonText={busy ? 'Restoring…' : 'Restore version as a new draft'} secondaryButtonText="Cancel" primaryButtonDisabled={busy} modalHeading={rollbackTarget ? 'Confirm decision rollback' : 'Decision version history'} size="lg">
    <Stack gap={5}>
      {!decisionId && <p>Save the decision before viewing its version history.</p>}
      {loading && <InlineLoading description="Loading version history…" />}
      {error && <InlineNotification kind="error" title="Version request failed" subtitle={error} onCloseButtonClick={() => setError(null)} />}
      {rollbackTarget ? <p>Restore {decisionId} to snapshot version {rollbackTarget}. The current saved version {expectedVersion} remains in history, and the restored rules require a new governance review.</p> : Boolean(versions.length) && <>
        <Grid fullWidth><Column lg={8} md={4} sm={4}><Select id="decision-base-version" labelText="Base version" value={v1} onChange={event => setV1(Number(event.target.value))}>{versions.map(version => <SelectItem key={version.version} value={version.version} text={`Version ${version.version} · ${version.change_summary || 'Saved update'}`} />)}</Select></Column><Column lg={8} md={4} sm={4}><Select id="decision-comparison-version" labelText="Comparison version" value={v2} onChange={event => setV2(Number(event.target.value))}>{versions.map(version => <SelectItem key={version.version} value={version.version} text={`Version ${version.version} · ${version.change_summary || 'Saved update'}`} />)}</Select></Column></Grid>
        <Button size="sm" kind="danger--tertiary" onClick={() => setRollbackTarget(v1)} disabled={!canRollback || loading || !expectedVersion}>Review rollback to version {v1}</Button>
        <Grid fullWidth>{[[v1, diff?.rulesV1 || []], [v2, diff?.rulesV2 || []]].map(([version, rules], index) => <Column key={index} lg={8} md={8} sm={4}><TableContainer title={`Version ${version}`}><Table size="md"><TableHead><TableRow><TableHeader>Rule</TableHeader><TableHeader>Description</TableHeader></TableRow></TableHead><TableBody>{rules.length ? rules.map((rule, ruleIndex) => <TableRow key={rule._id || ruleIndex}><TableCell>{ruleIndex + 1}</TableCell><TableCell>{rule._description || JSON.stringify(rule)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={2}>No decision-table rules in this snapshot.</TableCell></TableRow>}</TableBody></Table></TableContainer></Column>)}</Grid>
      </>}
    </Stack>
  </Modal>;
}
