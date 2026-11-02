/** Clear account content on shared browsers, retaining only display preferences. */
export function clearPrivateClientData(): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name];
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (key && (/^buddy(?:[.:\-])/.test(key) && ![
          'buddy-ui-theme', 'buddy-appearance-v1', 'buddy-appearance-owner', 'buddy-display-density', 'buddy-voice-id',
        ].includes(key) || /^onlyoffice_ai_/.test(key) || key === 'microsoft_connected')) {
          storage.removeItem(key);
        }
      }
    } catch { /* Restricted browser storage must not block local sign-out. */ }
  }
}
