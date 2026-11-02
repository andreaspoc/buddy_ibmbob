import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../lib/i18n';

interface Settings {
  enabled: boolean;
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  username: string;
  from_address: string;
  from_name: string;
  password_configured: boolean;
}
async function smtpRequest<T>(options?: RequestInit, test = false): Promise<T> {
  const response = await fetch(`/admin/smtp${test ? '/test' : ''}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not update SMTP settings.');
  return data as T;
}

export function SmtpSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [password, setPassword] = useState('');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    smtpRequest<Settings>().then(data => { if (active) { setSaved(data); setDraft(data); } })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : 'Could not load SMTP settings.'); })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, []);
  const dirty = Boolean(password) || JSON.stringify(draft) !== JSON.stringify(saved);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy('save'); setError(''); setNotice('');
    try {
      const { password_configured: _configured, ...settings } = draft;
      const data = await smtpRequest<Settings>({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, password }) });
      setSaved(data); setDraft(data); setPassword(''); setNotice('SMTP settings saved.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save SMTP settings.'); }
    finally { setBusy(null); }
  }
  async function test(event: FormEvent) {
    event.preventDefault(); setBusy('test'); setError(''); setNotice('');
    try {
      await smtpRequest({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: recipient.trim() }) }, true);
      setNotice('Test email accepted by the SMTP server. Check the recipient inbox.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send test email.'); }
    finally { setBusy(null); }
  }
  return <section aria-labelledby="smtp-settings-title">
    <h2 id="smtp-settings-title">{t('Outgoing email (SMTP)')}</h2>
    <p>{t('Configure your SMTP server and shared sender address. Only administrators can manage these settings.')}</p>
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    {notice && <p role="status" className="administration-notice">{t(notice)}</p>}
    {busy === 'load' && <p role="status">{t('Loading SMTP settings…')}</p>}
    {draft && <>
      <form onSubmit={event => void save(event)} className="smtp-settings-form">
        <fieldset disabled={busy !== null}>
          <label className="access-inline-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />{t('Enable SMTP email')}</label>
          <div className="smtp-settings-grid">
            <label>{t('SMTP host')}<input required={draft.enabled} maxLength={255} value={draft.host} placeholder="mail.example.com" autoComplete="off" onChange={event => setDraft({ ...draft, host: event.target.value })} /></label>
            <label>{t('SMTP port')}<input type="number" required min={1} max={65535} value={draft.port} onChange={event => setDraft({ ...draft, port: Number(event.target.value) })} /></label>
            <label>{t('Connection security')}<select value={draft.security} onChange={event => setDraft({ ...draft, security: event.target.value as Settings['security'] })}><option value="starttls">STARTTLS</option><option value="tls">{t('Implicit TLS')}</option><option value="none">{t('None (unencrypted)')}</option></select></label>
            <label>{t('SMTP username')}<input value={draft.username} autoComplete="off" onChange={event => setDraft({ ...draft, username: event.target.value })} /></label>
            <label>{t('SMTP password')}<input type="password" value={password} autoComplete="new-password" aria-describedby="smtp-password-help" onChange={event => setPassword(event.target.value)} /><small id="smtp-password-help">{t(draft.password_configured ? 'A password is saved. Leave blank to keep it.' : 'No password is saved. Leave blank if authentication is not required.')}</small></label>
            <label>{t('Sender email address')}<input type="email" required={draft.enabled} value={draft.from_address} autoComplete="off" onChange={event => setDraft({ ...draft, from_address: event.target.value })} /></label>
            <label>{t('Sender name')}<input value={draft.from_name} maxLength={200} onChange={event => setDraft({ ...draft, from_name: event.target.value })} /></label>
          </div>
          <button type="submit" disabled={!dirty}>{t(busy === 'save' ? 'Saving…' : 'Save SMTP settings')}</button>
        </fieldset>
      </form>
      <form className="administration-invite smtp-test-form" onSubmit={event => void test(event)}>
        <label>{t('Test recipient')}<input type="email" required value={recipient} autoComplete="email" disabled={busy !== null} onChange={event => setRecipient(event.target.value)} /></label>
        <button type="submit" disabled={busy !== null || dirty || !saved?.enabled || !recipient.trim()}>{t(busy === 'test' ? 'Sending…' : 'Send test email')}</button>
      </form>
      <p>{t('Save your settings before sending a test email. SMTP must be enabled.')}</p>
    </>}
  </section>;
}
