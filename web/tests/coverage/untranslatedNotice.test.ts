import { describe, expect, it } from 'vitest';
import { untranslatedWarning } from '../../src/lib/untranslatedNotice';

describe('untranslatedWarning', () => {
  it('is empty when everything was translated', () => {
    expect(untranslatedWarning()).toBe('');
    expect(untranslatedWarning([])).toBe('');
  });

  it('names the languages that still hold the original text', () => {
    expect(untranslatedWarning(['el', 'hi'])).toContain('EL, HI');
  });
});
