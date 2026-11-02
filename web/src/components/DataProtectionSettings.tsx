import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../lib/i18n';

type Action = 'allow' | 'ask' | 'block';
interface CustomRule { name: string; terms: string[]; action: 'ask' | 'block' }
interface Policy {
  categories: Record<string, Action>;
  channels: Record<string, boolean>;
  custom_rules: CustomRule[];
  available_categories: string[];
  available_channels: string[];
}
const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email', download: 'File downloads', external_tool: 'Connected services and tools',
  external_agent: 'External agents', share: 'Conversation share links',
};
const ACTIONS: [Action, string][] = [['allow', 'Allow'], ['ask', 'Ask first'], ['block', 'Block']];
const errorText = (data: { detail?: unknown }, fallback: string) => typeof data.detail === 'string' ? data.detail : fallback;

export function DataProtectionSettings() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [termDrafts, setTermDrafts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const accept = (data: Policy) => { setPolicy(data); setTermDrafts(data.custom_rules.map(rule => rule.terms.join('\n'))); };
  useEffect(() => {
    let active = true;
    fetch('/admin/privacy-policy').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(errorText(data, t('Could not load data protection rules.')));
      if (active) accept(data);
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : t('Could not load data protection rules.')); });
    return () => { active = false; };
  }, []);
  if (!policy) return <section aria-label={t('Data protection')}>{error ? <p role="alert">{error}</p> : <p>{t('Loading…')}</p>}</section>;
  const updateRule = (index: number, change: Partial<CustomRule>) =>
    setPolicy({ ...policy, custom_rules: policy.custom_rules.map((rule, position) => position === index ? { ...rule, ...change } : rule) });
  const removeRule = (index: number) => {
    setPolicy({ ...policy, custom_rules: policy.custom_rules.filter((_, position) => position !== index) });
    setTermDrafts(termDrafts.filter((_, position) => position !== index));
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!policy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/admin/privacy-policy', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categories: policy.categories, channels: policy.channels,
          custom_rules: policy.custom_rules.map((rule, index) => ({ ...rule, terms: termDrafts[index].split('\n') })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(errorText(data, t('Check each custom rule has a name and at least one term.')));
      accept(data);
      setNotice(t('Data protection rules saved.'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not save data protection rules.'));
    } finally { setBusy(false); }
  }
  return <section className="data-protection" aria-labelledby="data-protection-title">
    <h2 id="data-protection-title">{t('Data protection')}</h2>
    <p>{t('Decide what may leave Buddy. Block cannot be overridden. Ask first lets the person sending decide. Course certificates are exempt.')}</p>
    <form onSubmit={event => void save(event)}>
      <fieldset><legend>{t('Check these outgoing paths')}</legend>
        {policy.available_channels.map(channel => <label key={channel} className="data-protection-check"><input type="checkbox" checked={policy.channels[channel]} onChange={event => setPolicy({ ...policy, channels: { ...policy.channels, [channel]: event.target.checked } })} />{t(CHANNEL_LABELS[channel] ?? channel)}</label>)}
      </fieldset>
      <fieldset><legend>{t('Types of data')}</legend>
        {policy.available_categories.map(category => <label key={category} className="data-protection-row"><span>{t(category)}</span><select value={policy.categories[category]} onChange={event => setPolicy({ ...policy, categories: { ...policy.categories, [category]: event.target.value as Action } })}>{ACTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>)}
      </fieldset>
      <fieldset><legend>{t('Your own rules')}</legend>
        <p>{t('Add words or phrases, such as project names or client names. Matching ignores capitals and Greek accents.')}</p>
        {policy.custom_rules.map((rule, index) => <div key={index} className="data-protection-rule">
          <label>{t('Rule name')}<input required maxLength={80} value={rule.name} onChange={event => updateRule(index, { name: event.target.value })} /></label>
          <label>{t('Words or phrases, one per line')}<textarea required rows={3} value={termDrafts[index]} onChange={event => setTermDrafts(termDrafts.map((draft, position) => position === index ? event.target.value : draft))} /></label>
          <label>{t('Action')}<select value={rule.action} onChange={event => updateRule(index, { action: event.target.value as 'ask' | 'block' })}><option value="ask">{t('Ask first')}</option><option value="block">{t('Block')}</option></select></label>
          <button type="button" onClick={() => removeRule(index)}>{t('Remove rule')}</button>
        </div>)}
        <button type="button" onClick={() => { setPolicy({ ...policy, custom_rules: [...policy.custom_rules, { name: '', terms: [], action: 'block' }] }); setTermDrafts([...termDrafts, '']); }}>{t('Add rule')}</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" disabled={busy}>{t(busy ? 'Saving…' : 'Save rules')}</button>
    </form>
  </section>;
}
