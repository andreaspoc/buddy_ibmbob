// Scan each credential name and URL userinfo once, including long near misses.
function maskAssignments(value: string): string {
  const names = /[\w-]+/g;
  const sensitive = /api[_-]?key|token|secret|password|authorization|credential/i;
  const pieces: string[] = [];
  let end = 0;
  for (let name = names.exec(value); name; name = names.exec(value)) {
    if (!sensitive.test(name[0])) continue;
    let cursor = names.lastIndex;
    if (value[cursor] === '"' || value[cursor] === "'") cursor++;
    while (cursor < value.length && /\s/.test(value[cursor])) cursor++;
    if (value[cursor] !== ':' && value[cursor] !== '=') continue;
    cursor++;
    while (cursor < value.length && /\s/.test(value[cursor])) cursor++;
    if (value[cursor] === '"' || value[cursor] === "'") cursor++;
    const start = cursor;
    while (cursor < value.length && !/[\s"'&,}]/.test(value[cursor])) cursor++;
    if (cursor === start) continue;
    pieces.push(value.slice(end, start), '[redacted]');
    end = cursor;
    names.lastIndex = cursor;
  }
  return pieces.join('') + value.slice(end);
}

function maskUserinfo(value: string): string {
  return value.replace(/https?:\/\/[^/@\s]+@/g, match => {
    const start = match.indexOf('://') + 3;
    const userinfo = match.slice(start, -1);
    const colon = userinfo.indexOf(':', 1);
    return colon >= 0 && colon < userinfo.length - 1
      ? match.slice(0, start) + '[redacted]@' : match;
  });
}

// Defense for historical tool activity recorded before server-side masking.
export function redactActivity<T>(value: T): T {
  if (typeof value === 'string') return maskUserinfo(maskAssignments(value
    .replace(/(Bearer\s+)[^\s'"\\]+/gi, '$1[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
  )) as T;
  if (Array.isArray(value)) return value.map(item => redactActivity(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /key|token|secret|password|authorization|credential/i.test(key) ? '[redacted]' : redactActivity(item)])) as T;
  return value;
}
