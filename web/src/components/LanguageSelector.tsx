import { parseLanguage, setLanguage, t, useLanguage } from '../lib/i18n';

export function LanguageSelector() {
  const language = useLanguage();
  return <label className="language-selector">
    <span className="sr-only">{t('Language')}</span>
    <select aria-label={t('Language')} value={language}
      onChange={event => setLanguage(parseLanguage(event.target.value))}>
      <option value="en">English</option>
      <option value="el">Ελληνικά</option>
      <option value="hi">हिन्दी</option>
      <option value="mt">Malti</option>
    </select>
  </label>;
}
