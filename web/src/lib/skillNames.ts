const legacyNames: Record<string, string> = {
  'data-analyst': 'data-buddy',
  'interactive-presentations': 'presentation-buddy',
  'web-search': 'research-buddy',
  rag: 'knowledge-buddy',
  'code-review-lite': 'code-review-buddy',
  'a2a-agent': 'agent-buddy',
};

export function buddySkillName(name: string): string {
  if (legacyNames[name]) return legacyNames[name];
  if (!name || name.endsWith('-buddy')) return name;
  const stem = name.replace(/-(?:skill|agent)$/, '');
  let end = Math.min(stem.length, 58);
  while (end > 0 && stem[end - 1] === '-') end--;
  return `${stem.slice(0, end)}-buddy`;
}

/** Human-readable label only. Keep the original name in API requests and commands. */
export function skillDisplayName(name: string): string {
  const acronyms = new Set(['ai', 'api', 'sql', 'csv', 'html', 'pdf', 'ui', 'ux', 'a2a', 'pptx', 'rag', 'ibm', 'mcp']);
  return (legacyNames[name] || name).trim().split(/[-_\s]+/).filter(Boolean)
    .map(word => acronyms.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
