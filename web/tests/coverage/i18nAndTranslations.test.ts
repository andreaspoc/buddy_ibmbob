// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { parseLanguage, getLanguage, getLocale, setLanguage, t } from '../../src/lib/i18n';

describe('i18n internationalization and translation helpers', () => {
  beforeEach(() => {
    setLanguage('en');
  });

  it('parseLanguage parses valid languages and defaults to en', () => {
    expect(parseLanguage('el')).toBe('el');
    expect(parseLanguage('hi')).toBe('hi');
    expect(parseLanguage('mt')).toBe('mt');
    expect(parseLanguage('fr')).toBe('en');
    expect(parseLanguage(null)).toBe('en');
    expect(parseLanguage(undefined)).toBe('en');
    expect(parseLanguage(123)).toBe('en');
  });

  it('getLanguage, getLocale and setLanguage update document and storage', () => {
    setLanguage('el');
    expect(getLanguage()).toBe('el');
    expect(getLocale()).toBe('el-GR');
    expect(document.documentElement.lang).toBe('el');

    setLanguage('hi');
    expect(getLanguage()).toBe('hi');
    expect(getLocale()).toBe('hi-IN');
    expect(document.documentElement.lang).toBe('hi');

    setLanguage('mt');
    expect(getLanguage()).toBe('mt');
    expect(getLocale()).toBe('mt-MT');
    expect(document.documentElement.lang).toBe('mt');

    setLanguage('en');
    expect(getLanguage()).toBe('en');
    expect(getLocale()).toBe('en-GB');
  });

  it('t translates parameterized strings with indexed placeholders', () => {
    setLanguage('en');
    expect(t('Hello {0}, you have {1} messages', ['Marcus', 5])).toBe('Hello Marcus, you have 5 messages');
    expect(t('Keep {0} and unreplaced {1}', ['Value'])).toBe('Keep Value and unreplaced {1}');
  });

  it('t handles runtime activity translation for Greek (el)', () => {
    setLanguage('el');
    expect(t('Completed in 4.5s')).toContain('Ολοκληρώθηκε σε');
    expect(t('Completed in Done')).toBe('Ολοκληρώθηκε');
    expect(t('Completed in 10 minutes')).toBe('Ολοκληρώθηκε σε 10 minutes');
    expect(t('Using skill Research…')).toBe('Χρήση δεξιότητας Research…');
    expect(t('Using git_status…')).toBe('Χρήση εργαλείου git_status…');
    expect(t('Error: Network timeout')).toContain('Σφάλμα:');
  });

  it('t handles runtime activity translation for Hindi (hi)', () => {
    setLanguage('hi');
    expect(t('Completed in 2.5s')).toContain('सेकंड में पूरा हुआ');
    expect(t('Completed in Done')).toBe('पूरा हुआ');
    expect(t('Completed in 5 minutes')).toBe('5 minutes में पूरा हुआ');
    expect(t('Using skill CodeAnalysis…')).toBe('CodeAnalysis कौशल का उपयोग हो रहा है…');
    expect(t('Using web_search…')).toBe('web_search टूल का उपयोग हो रहा है…');
    expect(t('Error: Storage full')).toContain('त्रुटि:');
  });

  it('t handles runtime activity translation for Maltese (mt)', () => {
    setLanguage('mt');
    expect(t('Completed in 3.0s')).toContain('Tlesta fi');
    expect(t('Completed in Done')).toBe('Tlesta');
    expect(t('Completed in 15 seconds')).toBe('Tlesta fi 15 seconds');
    expect(t('Using skill Testing…')).toBe('Qed tintuża l-ħila Testing…');
    expect(t('Using terminal…')).toBe('Qed tintuża l-għodda terminal…');
    expect(t('Error: Access denied')).toContain('Żball:');
  });

  it('handles storage event updates', () => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'bob-ui-language',
      newValue: 'hi',
    }));
    expect(getLanguage()).toBe('hi');
    expect(document.documentElement.lang).toBe('hi');

    // Ignored storage events
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'other-key',
      newValue: 'el',
    }));
    expect(getLanguage()).toBe('hi');
  });
});
