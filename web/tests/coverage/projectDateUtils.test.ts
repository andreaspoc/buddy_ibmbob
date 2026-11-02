import { expect, test } from 'vitest';
import { addMonthsToDate, calculateDurationSummary } from '../../src/components/ProjectDateUtils';
test('month offsets clamp to the last day of shorter months', () => {
  expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
  expect(addMonthsToDate('2024-01-31', 1)).toBe('2024-02-29');
  expect(addMonthsToDate('2026-03-31', -1)).toBe('2026-02-28');
  expect(addMonthsToDate('2026-11-30', 3)).toBe('2027-02-28');
  expect(addMonthsToDate('2026-01-15', 1)).toBe('2026-02-15');
});
test('duration summary distinguishes missing, same-day, reversed and ordinary dates', () => {
  expect(calculateDurationSummary(null, '2026-01-01')).toBeNull();
  expect(calculateDurationSummary('2026-01-01', '2026-01-01')).toContain('0 days');
  expect(calculateDurationSummary('2026-01-02', '2026-01-01')).toContain('earlier');
  expect(calculateDurationSummary('2026-01-01', '2026-01-08')).toContain('7 calendar days');
});
