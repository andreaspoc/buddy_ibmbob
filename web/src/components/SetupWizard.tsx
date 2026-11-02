import { Button, InlineNotification, PasswordInput } from '@carbon/react';
import { useEffect, useState } from 'react';
import { getBrand } from '../lib/brand';
import { t } from '../lib/i18n';
import { LogoField, NameFields, saveBrand } from './BrandingFields';
import './SetupWizard.css';

type KeyStatus = { saved: boolean; environment_configured: boolean; encryption_available: boolean };

/** First-run setup: name, logo, then a working provider key or a deliberate skip. */
export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(getBrand().name);
  const [organization, setOrganization] = useState(getBrand().organization);
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (step !== 2) return;
    fetch('/admin/bob-key').then(response => response.ok ? response.json() : null).then(setKeyStatus).catch(() => setKeyStatus(null));
  }, [step]);

  const attempt = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };
  const finish = async (skipProvider: boolean) => {
    const response = await fetch('/admin/setup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skip_provider: skipProvider }) });
    if (!response.ok) throw new Error('Could not finish setup.');
    window.location.reload();
  };
  const saveKeyAndFinish = async () => {
    const response = await fetch('/admin/bob-key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey }) });
    if (!response.ok) throw new Error('Could not save the key.');
    await finish(false);
  };
  const hasKey = Boolean(keyStatus?.saved || keyStatus?.environment_configured);

  return <main className="setup-wizard"><div className="setup-card">
    <p className="setup-step">{t('Step {0} of {1}', [step + 1, 3])}</p>
    {step === 0 && <div className="setup-fields">
      <h1>{t('Name your assistant')}</h1>
      <NameFields name={name} organization={organization} onName={setName} onOrganization={setOrganization} />
      <div className="setup-actions"><Button disabled={busy || !name.trim()} onClick={() => void attempt(async () => { await saveBrand(name, organization); setStep(1); })}>{t('Continue')}</Button></div>
    </div>}
    {step === 1 && <div className="setup-fields">
      <h1>{t('Add a logo')}</h1>
      <p>{t('This is optional. You can change it later under Administration.')}</p>
      <LogoField />
      <div className="setup-actions"><Button kind="secondary" onClick={() => setStep(0)}>{t('Back')}</Button><Button onClick={() => setStep(2)}>{t('Continue')}</Button></div>
    </div>}
    {step === 2 && <div className="setup-fields">
      <h1>{t('Connect a provider')}</h1>
      {hasKey
        ? <p>{t('A Bob API key is already configured.')}</p>
        : <>
          <p>{t('Chat needs a Bob API key. If you skip this, you can use the workspace, but the assistant cannot answer until an administrator adds a key.')}</p>
          {keyStatus && !keyStatus.encryption_available && <InlineNotification kind="warning" lowContrast hideCloseButton title={t('Keys cannot be saved here because the service encryption key is missing. Set BUDDY_MEMORY_SIGNING_KEY or skip this step.')} />}
          <PasswordInput id="setup-bob-key" labelText={t('Bob API key')} autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} />
        </>}
      <div className="setup-actions">
        <Button kind="secondary" onClick={() => setStep(1)}>{t('Back')}</Button>
        {hasKey
          ? <Button disabled={busy} onClick={() => void attempt(() => finish(false))}>{t('Start working')}</Button>
          : <>
            <Button kind="tertiary" disabled={busy} onClick={() => void attempt(() => finish(true))}>{t('Skip for now')}</Button>
            <Button disabled={busy || !apiKey.trim() || !keyStatus?.encryption_available} onClick={() => void attempt(saveKeyAndFinish)}>{t('Save and start')}</Button>
          </>}
      </div>
    </div>}
    {error && <InlineNotification kind="error" lowContrast hideCloseButton title={t(error)} />}
  </div></main>;
}
