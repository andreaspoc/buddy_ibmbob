import { brandText } from './brand';
import { aiTransparencyCatalog } from './aiTransparencyCatalog';
import { securityCatalog } from './securityCatalog';
import { diagramLayoutCatalog } from './diagramLayoutCatalog';
import { interactiveCatalog } from './interactiveCatalog';
import { appsCatalog } from './appsCatalog';
import { useSyncExternalStore } from 'react';
import { workspaceGreekCatalog } from './workspaceGreekCatalog';
import { workspaceHindiCatalog } from './workspaceHindiCatalog';
import { workspaceMalteseCatalog } from './workspaceMalteseCatalog';
import { greekCatalog } from './greekCatalog';
import { hindiCatalog } from './hindiCatalog';
import { malteseCatalog } from './malteseCatalog';
import { officeCatalog } from './officeCatalog';
import { officeFoldersCatalog } from './officeFoldersCatalog';
import { notesCatalog } from './notesCatalog';
export type Language = 'en' | 'el' | 'hi' | 'mt';
export function parseLanguage(value: unknown): Language {
  return value === 'el' || value === 'hi' || value === 'mt' ? value : 'en';
}
const storageKey = 'bob-ui-language';
let memoryLanguage: Language = 'en';
try { memoryLanguage = parseLanguage(localStorage.getItem(storageKey)); } catch { /* In-memory selection works when storage is restricted. */ }
const listeners = new Set<() => void>();
export function getLanguage(): Language {
  return memoryLanguage;
}
export function getLocale(): string {
  return { en: 'en-GB', el: 'el-GR', hi: 'hi-IN', mt: 'mt-MT' }[getLanguage()];
}
export function setLanguage(language: Language): void {
  memoryLanguage = language;
  try { localStorage.setItem(storageKey, language); } catch { /* Restricted storage. */ }
  document.documentElement.lang = language;
  listeners.forEach(listener => listener());
}
export function useLanguage(): Language {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, getLanguage, () => 'en');
}
export function t(text: string, values: ReadonlyArray<string | number | undefined | null> = []): string {
  const language = getLanguage();
  const catalog = language === 'el' ? greekCatalog : language === 'hi' ? hindiCatalog : language === 'mt' ? malteseCatalog : {};
  const workspaceCatalog = language === 'el' ? workspaceGreekCatalog : language === 'hi' ? workspaceHindiCatalog : language === 'mt' ? workspaceMalteseCatalog : {};
  let translated = aiTransparencyCatalog[language]?.[text] ?? securityCatalog[language]?.[text] ?? diagramLayoutCatalog[language]?.[text] ?? interactiveCatalog[language]?.[text] ?? appsCatalog[language]?.[text] ?? workspaceCatalog[text] ?? officeFoldersCatalog[language]?.[text] ?? officeCatalog[language]?.[text] ?? notesCatalog?.[language]?.[text] ?? catalog[text] ?? text;
  if (language !== 'en' && translated === text) {
    // Runtime activity includes variable durations, skill names, and tool names.
    const completed = /^Completed in (.+)$/.exec(text);
    const skill = /^Using skill (.+?)(?:…|\.\.\.)?$/.exec(text);
    const tool = /^Using (.+?)(?:…|\.\.\.)?$/.exec(text);
    const error = /^Error: (.+)$/.exec(text);
    if (completed) {
      const duration = /^(\d+(?:\.\d+)?)s$/.exec(completed[1]);
      const seconds = duration && Number(duration[1]).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      translated = language === 'mt'
        ? duration ? `Tlesta fi ${seconds} sekondi` : completed[1] === 'Done' ? 'Tlesta' : `Tlesta fi ${completed[1]}`
        : language === 'hi'
        ? duration ? `${seconds} सेकंड में पूरा हुआ` : completed[1] === 'Done' ? 'पूरा हुआ' : `${completed[1]} में पूरा हुआ`
        : duration ? `Ολοκληρώθηκε σε ${seconds} δευτ.` : completed[1] === 'Done' ? 'Ολοκληρώθηκε' : `Ολοκληρώθηκε σε ${completed[1]}`;
    } else if (skill) translated = language === 'mt' ? `Qed tintuża l-ħila ${skill[1]}…` : language === 'hi' ? `${skill[1]} कौशल का उपयोग हो रहा है…` : `Χρήση δεξιότητας ${skill[1]}…`;
    else if (tool) translated = language === 'mt' ? `Qed tintuża l-għodda ${tool[1]}…` : language === 'hi' ? `${tool[1]} टूल का उपयोग हो रहा है…` : `Χρήση εργαλείου ${tool[1]}…`;
    else if (error) translated = `${language === 'mt' ? 'Żball' : language === 'hi' ? 'त्रुटि' : 'Σφάλμα'}: ${catalog[error[1]] ?? error[1]}`;
  }
  return brandText(translated).replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] === undefined ? match : String(values[Number(index)]));
}
if (typeof window !== 'undefined') {
  document.documentElement.lang = getLanguage();
  window.addEventListener('storage', event => {
    if (event.key === storageKey) { memoryLanguage = parseLanguage(event.newValue); document.documentElement.lang = getLanguage(); listeners.forEach(listener => listener()); }
  });
}
