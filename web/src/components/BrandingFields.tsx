import { Button, InlineNotification, TextInput } from '@carbon/react';
import { useState, type ChangeEvent } from 'react';
import { brandLogoUrl, getBrand } from '../lib/brand';
import { t } from '../lib/i18n';

async function failure(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}));
  if (typeof body.detail === 'string') return body.detail;
  return Array.isArray(body.detail) && typeof body.detail[0]?.msg === 'string' ? body.detail[0].msg.replace(/^Value error, /, '') : fallback;
}

export async function saveBrand(name: string, organization: string): Promise<void> {
  const response = await fetch('/admin/branding', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, organization }) });
  if (!response.ok) throw new Error(await failure(response, 'Could not save the name.'));
}

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => reject(new Error('Could not read this file.'));
  reader.readAsDataURL(file);
});

export function NameFields({ name, organization, onName, onOrganization }: { name: string; organization: string; onName: (value: string) => void; onOrganization: (value: string) => void }) {
  return <>
    <TextInput id="brand-name" labelText={t('Assistant name')} helperText={t('People see this name everywhere, and the assistant uses it for itself.')} value={name} maxLength={40} onChange={event => onName(event.target.value)} />
    <TextInput id="brand-organization" labelText={t('Organization (optional)')} value={organization} maxLength={80} onChange={event => onOrganization(event.target.value)} />
  </>;
}

export function LogoField() {
  const [preview, setPreview] = useState(getBrand().has_logo ? brandLogoUrl() : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/admin/branding/logo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_base64: await toBase64(file) }) });
      if (!response.ok) throw new Error(await failure(response, 'Could not save the logo.'));
      setPreview(URL.createObjectURL(file));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the logo.'); }
    finally { setBusy(false); event.target.value = ''; }
  };
  const remove = async () => {
    setBusy(true); setError('');
    const response = await fetch('/admin/branding/logo', { method: 'DELETE' }).catch(() => null);
    if (response?.ok) setPreview(''); else setError('Could not remove the logo.');
    setBusy(false);
  };
  return <div className="setup-logo">
    {preview && <img src={preview} width="72" height="72" alt={t('Logo preview')} />}
    <label>{t('Logo (PNG, JPEG or WebP, up to 1 MB)')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => void upload(event)} /></label>
    {preview && <Button kind="ghost" size="sm" disabled={busy} onClick={() => void remove()}>{t('Remove logo')}</Button>}
    {error && <InlineNotification kind="error" lowContrast hideCloseButton title={t(error)} />}
  </div>;
}

export function BrandingSettings() {
  const [name, setName] = useState(getBrand().name);
  const [organization, setOrganization] = useState(getBrand().organization);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    try { await saveBrand(name, organization); window.location.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save the name.'); }
  };
  return <section aria-labelledby="branding-title" className="setup-fields">
    <h2 id="branding-title">{t('Name & logo')}</h2>
    <NameFields name={name} organization={organization} onName={setName} onOrganization={setOrganization} />
    {error && <InlineNotification kind="error" lowContrast hideCloseButton title={t(error)} />}
    <Button disabled={!name.trim()} onClick={() => void save()}>{t('Save name')}</Button>
    <LogoField />
  </section>;
}
