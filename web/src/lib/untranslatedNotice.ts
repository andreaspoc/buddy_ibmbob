/** Warning shown when Buddy could not translate a draft into some languages. */
export function untranslatedWarning(languages?: string[]) {
  return languages?.length ? ` Translation failed for ${languages.join(', ').toUpperCase()}: that version still contains the original text, so translate it before approving.` : '';
}
