export function formatIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTodayIso(): string {
  return formatIsoDate(new Date());
}

export function getNextMondayIso(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + diff);
  return formatIsoDate(d);
}

export function addDaysToDate(baseDateStr: string | null | undefined, days: number): string {
  const base = baseDateStr ? new Date(`${baseDateStr}T00:00:00`) : new Date();
  base.setDate(base.getDate() + days);
  return formatIsoDate(base);
}

export function addMonthsToDate(baseDateStr: string | null | undefined, months: number): string {
  const base = baseDateStr ? new Date(`${baseDateStr}T00:00:00`) : new Date();
  const day = base.getDate();
  base.setDate(1);
  base.setMonth(base.getMonth() + months);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  base.setDate(Math.min(day, lastDay));
  return formatIsoDate(base);
}

export function calculateDurationSummary(start: string | null | undefined, due: string | null | undefined): string | null {
  if (!start || !due) return null;
  const s = new Date(`${start}T00:00:00`);
  const d = new Date(`${due}T00:00:00`);
  const diffTime = d.getTime() - s.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  if (Number.isNaN(diffDays)) return null;
  if (diffDays < 0) return '⚠ Due date is earlier than start date';
  if (diffDays === 0) return '⚡ 0 days (Single-day milestone)';
  const weeks = (diffDays / 7).toFixed(1);
  return `⏱ ${diffDays} calendar days (~${weeks} weeks)`;
}

export function getDueBadge(due: string | null | undefined): { label: string; tone: 'danger' | 'warning' | 'normal' } | null {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${due}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    const abs = Math.abs(diffDays);
    return { label: abs === 1 ? '1d Overdue' : `${abs}d Overdue`, tone: 'danger' };
  }
  if (diffDays === 0) return { label: 'Due today', tone: 'warning' };
  if (diffDays === 1) return { label: 'Due tomorrow', tone: 'warning' };
  if (diffDays <= 7) return { label: `Due in ${diffDays}d`, tone: 'warning' };
  return { label: `Due in ${diffDays}d`, tone: 'normal' };
}
