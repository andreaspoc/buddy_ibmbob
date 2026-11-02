import { useEffect, useState } from 'react';
import { ACCENT_PRESETS, DEFAULT_ACCENT, DEFAULT_ASSISTANT_NAME, DEFAULT_COMPANY_NAME, isValidAssistantName, readAppearance, readDesignTheme, renderedAccent, saveAppearance, setDesignTheme, watchAccountSave, type DesignTheme } from '../lib/appearance';
import { t } from '../lib/i18n';
import './AppearanceSettings.css';

export function AppearanceSettings() {
  const [saved] = useState(readAppearance);
  const [accent, setAccent] = useState(saved.accent);
  const [name, setName] = useState(saved.assistantName === DEFAULT_ASSISTANT_NAME ? '' : saved.assistantName);
  const [company, setCompany] = useState(saved.companyName === DEFAULT_COMPANY_NAME ? '' : saved.companyName);
  const [theme, setTheme] = useState<DesignTheme>(readDesignTheme);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => watchAccountSave(setSaveFailed), []);
  const nameValid = !name.trim() || isValidAssistantName(name.trim());
  const companyValid = !company.trim() || isValidAssistantName(company.trim());
  const shown = renderedAccent(accent);
  const chooseAccent = (value: string) => { setAccent(value); saveAppearance({ accent: value }); };
  const changeName = (value: string) => {
    setName(value);
    const next = value.trim();
    if (!next) saveAppearance({ assistantName: DEFAULT_ASSISTANT_NAME });
    else if (isValidAssistantName(next)) saveAppearance({ assistantName: next });
  };
  const changeCompany = (value: string) => {
    setCompany(value);
    const next = value.trim();
    if (!next) saveAppearance({ companyName: DEFAULT_COMPANY_NAME });
    else if (isValidAssistantName(next)) saveAppearance({ companyName: next });
  };
  const reset = () => { setAccent(DEFAULT_ACCENT); setName(''); setCompany(''); setTheme('copilotkit'); setDesignTheme('copilotkit'); saveAppearance({ accent: DEFAULT_ACCENT, assistantName: DEFAULT_ASSISTANT_NAME, companyName: DEFAULT_COMPANY_NAME }); };
  return <section className="appearance-settings" data-keep-open><h3>{t('Appearance')}</h3>
    <label className="workspace-language"><span>{t('Theme')}</span><select aria-label={t('Theme')} value={theme} onChange={event => { const next = event.target.value as DesignTheme; setTheme(next); setDesignTheme(next); }}><option value="copilotkit">{t('Neutral')}</option><option value="carbon">{t('Carbon')}</option></select></label>
    <label className="workspace-language"><span>{t('Company name')}</span><input type="text" aria-label={t('Company name')} aria-invalid={!companyValid} maxLength={24} placeholder={DEFAULT_COMPANY_NAME} value={company} onChange={event => changeCompany(event.target.value)} />{!companyValid && <small role="alert" className="appearance-error">{t('Use letters, numbers, spaces, hyphens or apostrophes.')}</small>}</label>
    <label className="workspace-language"><span>{t('Assistant name')}</span><input type="text" aria-label={t('Assistant name')} aria-invalid={!nameValid} maxLength={24} placeholder={DEFAULT_ASSISTANT_NAME} value={name} onChange={event => changeName(event.target.value)} />{!nameValid && <small role="alert" className="appearance-error">{t('Use letters, numbers, spaces, hyphens or apostrophes.')}</small>}</label>
    <div className="workspace-language"><span id="appearance-color-label">{t('Theme colour')}</span>
      <div className="appearance-swatches" role="radiogroup" aria-labelledby="appearance-color-label">{ACCENT_PRESETS.map(preset => <button type="button" key={preset.value} role="radio" aria-checked={accent === preset.value} aria-label={t(preset.name)} title={t(preset.name)} style={{ backgroundColor: renderedAccent(preset.value) }} onClick={() => chooseAccent(preset.value)} />)}
        <label className="appearance-custom" title={t('Custom colour')}><input type="color" aria-label={t('Custom colour')} value={accent} onChange={event => chooseAccent(event.target.value.toLowerCase())} /></label></div>
      {shown.toLowerCase() !== accent && accent !== DEFAULT_ACCENT && <small className="appearance-note">{t('Darkened slightly so button text stays readable.')}</small>}
    </div>
    {saveFailed && <small role="alert" className="appearance-error">{t('Saved on this browser only. It could not be saved to your account.')}</small>}
    <button type="button" onClick={reset}>{t('Reset appearance')}</button>
  </section>;
}
