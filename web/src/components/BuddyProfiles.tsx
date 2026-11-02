import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../lib/i18n';
import './BuddyProfiles.css';

type Provider = 'openai' | 'azure' | 'anthropic' | 'watsonx' | 'gemini' | 'bedrock' | 'openai_compatible';
type Profile = { id: string; name: string; provider: Provider; model: string; endpoint: string; credentials_configured: boolean; active: boolean };
type Draft = { instructions: string; allowed_tools: string[]; name: string; provider: Provider; model: string; endpoint: string; region: string; project_id: string; api_key: string; access_key_id: string; secret_access_key: string; session_token: string };
const empty: Draft = { instructions: '', allowed_tools: [], name: '', provider: 'openai', model: '', endpoint: '', region: '', project_id: '', api_key: '', access_key_id: '', secret_access_key: '', session_token: '' };
const providers: [Provider, string][] = [['openai','OpenAI'], ['azure','Azure OpenAI'], ['anthropic','Claude (Anthropic)'], ['watsonx','IBM watsonx.ai'], ['gemini','Google Gemini'], ['bedrock','Amazon Bedrock'], ['openai_compatible','Custom OpenAI-compatible']];

export function BuddyProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [active, setActive] = useState('bob');
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch('/admin/buddy-profiles');
    if (!response.ok) throw new Error('Could not load profiles.');
    const data = await response.json(); setProfiles(data.profiles); setActive(data.active_id); setEnabled(data.enabled);
  };
  useEffect(() => { void load().catch(() => setError('Could not load profiles.')); }, []);
  const field = (key: Exclude<keyof Draft, 'allowed_tools'>, label: string, secret = false, required = false) => <label>{t(label)}<input required={required} type={secret ? 'password' : 'text'} autoComplete={secret ? 'new-password' : 'off'} value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>;
  const select = async (nextEnabled: boolean, profileId: string) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/admin/buddy-profiles/selection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: nextEnabled, profile_id: profileId }) });
      if (!response.ok) throw new Error('Could not change the active profile.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not change the active profile.'); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/admin/buddy-profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      if (!response.ok) throw new Error('Could not save the profile.');
      setDraft(empty); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the profile.'); }
    finally { setBusy(false); }
  };
  return <section className="buddy-profiles" aria-labelledby="buddy-profiles-title">
    <h2 id="buddy-profiles-title">{t('Buddy model profiles')}</h2>
    <div className="buddy-profile-notice"><strong>{t('Configuration preview')}</strong><p>{t('Preview: save provider profiles for later. Provider activation is not available yet; IBM Bob remains active.')}</p></div>
    <p>{t('Provider credentials are saved securely and cannot be displayed again.')}</p>
    {error && <p role="alert">{t(error)}</p>}
    <div className="buddy-runtime-card"><label><input type="checkbox" disabled checked={enabled} onChange={event => void select(event.target.checked, 'bob')} />{t('Enable multi-provider mode')}</label>
    <label>{t('Active Buddy')}<select disabled={busy || !enabled} value={active} onChange={event => void select(true, event.target.value)}><option value="bob">IBM Bob</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
    <p>{t(active === 'bob' ? 'Active: IBM Bob' : 'A model profile is active.')}</p>
    </div><div className="buddy-saved-profiles"><h3>{t('Saved Buddies')}</h3>{profiles.length ? <ul>{profiles.map(profile => <li key={profile.id}><div><strong>{profile.name}</strong><small>{providers.find(([id]) => id === profile.provider)?.[1] || profile.provider}</small></div><code>{profile.model}</code><span className="buddy-profile-badge">{t(profile.active ? 'Active' : 'Saved')}</span></li>)}</ul> : <p>{t('No additional Buddies yet. Add your first provider profile below.')}</p>}</div>
    <form className="smtp-settings-form" onSubmit={event => void save(event)}>
      <fieldset className="buddy-profile-fields" disabled={busy}>
        <legend>{t('Add a provider profile')}</legend>
        <p className="buddy-form-description">{t('Give this Buddy a name, choose its model, and add the connection credentials.')}</p>
        {field('name', 'Profile name', false, true)}
        <label>{t('Provider')}<select value={draft.provider} onChange={event => setDraft({ ...empty, name: draft.name, provider: event.target.value as Provider })}>{providers.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {field('model', 'Model or deployment ID', false, true)}
        <label className="buddy-wide">{t('Buddy instructions')}<textarea value={draft.instructions} maxLength={16000} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
        <fieldset className="buddy-capabilities buddy-wide"><legend>{t('Allowed capabilities')}</legend>{['knowledge', 'mcp', 'files', 'commands', 'web'].map(capability => <label key={capability}><input type="checkbox" checked={draft.allowed_tools.includes(capability)} onChange={event => setDraft({ ...draft, allowed_tools: event.target.checked ? [...draft.allowed_tools, capability] : draft.allowed_tools.filter(item => item !== capability) })} />{t(({knowledge:'Knowledge search',mcp:'Connected services',files:'Files',commands:'Commands',web:'Web access'} as Record<string,string>)[capability])}</label>)}</fieldset>
        {['azure','watsonx','openai_compatible'].includes(draft.provider) && field('endpoint', 'HTTPS endpoint', false, true)}
        {draft.provider === 'watsonx' && field('project_id', 'watsonx project ID', false, true)}
        {draft.provider === 'bedrock' ? <>{field('region', 'AWS region', false, true)}{field('access_key_id', 'AWS access key ID', true, true)}{field('secret_access_key', 'AWS secret access key', true, true)}{field('session_token', 'AWS session token', true)}</> : field('api_key', 'API key', true, true)}
        <div className="buddy-form-footer buddy-wide"><span>{t('Credentials are encrypted and never shown again.')}</span><button type="submit" className="directory-primary">{t(busy ? 'Saving…' : 'Save profile')}</button></div>
      </fieldset>
    </form>
  </section>;
}
