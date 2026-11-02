/** Remove React imports for the sandbox's provided React global. */
export function prepareReactPreview(source: string): string {
  const lines = source.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*import\s/.test(lines[i])) { result.push(lines[i]); continue; }
    const declaration = [lines[i]];
    while (!declaration.at(-1)!.includes('from') && !declaration.at(-1)!.includes(';') && i + 1 < lines.length) {
      declaration.push(lines[++i]);
    }
    const statement = declaration.join('\n');
    const from = statement.lastIndexOf('from');
    const module = from < 0 ? '' : statement.slice(from + 4).trim().replace(/;$/, '').trim();
    if (module !== "'react'" && module !== '"react"') result.push(...declaration);
  }
  return result.join('\n').replace(/export\s+default\s+/, 'const ArtifactComponent = ').replace(/<\/script/gi, String.raw`<\/script`);
}
