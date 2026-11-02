import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../lib/i18n';

type Status = { saved: boolean; environment_configured: boolean; encryption_available: boolean };
export function BobKeySettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    const response = await fetch('/admin/bob-key');
    if (!response.ok) throw new Error('Could not load Bob key settings.');
    setStatus(await response.json());
  };
  useEffect(() => { void load().catch(() => setError('Could not load Bob key settings.')); }, []);
  const update = async (method: 'PUT' | 'DELETE') => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/admin/bob-key', method === 'PUT' ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key }) } : { method });
      if (!response.ok) throw new Error('Could not update the Bob key.');
      setKey(''); await load(); setMessage(method === 'PUT' ? 'Bob key saved for new sessions.' : 'Saved Bob key removed.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update the Bob key.'); }
    finally { setBusy(false); }
  };
  const save = (event: FormEvent) => { event.preventDefault(); void update('PUT'); };
  return <section aria-labelledby="bob-key-title">
    <h2 id="bob-key-title">{t('Bob API key')}</h2>
    <p>{t('The saved key is shared by all users and applies to new sessions. The Compose key is used when no UI key is saved.')}</p>
    {status && <p>{t(status.saved ? 'A UI key is saved.' : status.environment_configured ? 'Using the Compose key.' : 'No Bob key is configured.')}</p>}
    {status && !status.encryption_available && <p role="alert">{t('Credential encryption is unavailable. Ask an administrator to configure the service encryption key.')}</p>}
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    {message && <p role="status" className="administration-notice">{t(message)}</p>}
    <form className="administration-invite" onSubmit={save}>
      <label>{t('New Bob API key')}<input type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} /></label>
      <button type="submit" disabled={busy || !status?.encryption_available || !key.trim()}>{t('Save key')}</button>
      {status?.saved && <button type="button" disabled={busy} onClick={() => void update('DELETE')}>{t('Remove saved key')}</button>}
    </form>
  </section>;
}
