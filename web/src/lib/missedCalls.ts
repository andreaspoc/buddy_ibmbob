export type MissedCall = { id: string; title: string; room_id: number | null; kind?: string; color?: string; session_id?: string; caller?: string; occurred_at: string };
export const missedCallColors = ['rose', 'yellow', 'mint', 'sky', 'lavender'] as const;
export function groupMissedCalls(items: MissedCall[], previousColors: Record<string, string> = {}) {
  const groups = new Map<string, {key: string; latest: MissedCall; calls: MissedCall[]; color: string}>();
  for (const item of items) {
    const key = item.kind === 'reminder' ? item.id : item.caller || String(item.room_id);
    let group = groups.get(key);
    if (!group) {
      const hash = [...key].reduce((value, character) => ((value * 31 + character.charCodeAt(0)) >>> 0), 0);
      group = {key, latest: item, calls: [], color: item.kind === 'reminder' && item.color ? item.color === 'butter' ? 'yellow' : item.color : missedCallColors[hash % missedCallColors.length]};
      groups.set(key, group);
    }
    group.calls.push(item);
    if (item.occurred_at > group.latest.occurred_at) group.latest = item;
  }
  const ordered = [...groups.values()].sort((a, b) => b.latest.occurred_at.localeCompare(a.latest.occurred_at));
  const usage = new Map<string, number>(missedCallColors.map(color => [color, 0]));
  // Keep existing notes steady; use every palette color before repeating one.
  const allocation = [...ordered].sort((a, b) => Number(Boolean(previousColors[b.key])) - Number(Boolean(previousColors[a.key])));
  for (const group of allocation) {
    const preferred = previousColors[group.key] || group.color;
    const preferredIndex = missedCallColors.findIndex(color => color === preferred);
    const minimum = Math.min(...usage.values());
    const candidates = [...missedCallColors.slice(Math.max(0, preferredIndex)), ...missedCallColors.slice(0, Math.max(0, preferredIndex))];
    group.color = candidates.find(color => usage.get(color) === minimum)!;
    usage.set(group.color, usage.get(group.color)! + 1);
  }
  return ordered;
}
