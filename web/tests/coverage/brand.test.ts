import { beforeEach, describe, expect, it } from 'vitest';
import { brandLogoUrl, brandName, brandText, setBrand, setBrandOverrides } from '../../src/lib/brand';

const brand = { name: 'Aria', organization: 'Northwind', has_logo: false, logo_version: 0, setup_complete: true };

describe('instance brand', () => {
  beforeEach(() => { setBrandOverrides(null, null); setBrand(brand); });

  it('renames the assistant but keeps module names and identifiers', () => {
    expect(brandText('Ask Buddy now')).toBe('Ask Aria now');
    expect(brandText('Ο Buddy σκέφτεται')).toBe('Ο Aria σκέφτεται');
    expect(brandText('Office Buddy and Buddy Office')).toBe('Office Buddy and Buddy Office');
    expect(brandText('BuddyResearch buddy-worker')).toBe('BuddyResearch buddy-worker');
    expect(brandText('EXTEND BUDDY · LEARNING BUDDY')).toBe('EXTEND ARIA · LEARNING BUDDY');
  });

  it('fills the organization, or uses the assistant name when none was set', () => {
    expect(brandText('{{ORGANIZATION}} policies')).toBe('Northwind policies');
    setBrand({ ...brand, organization: '' });
    expect(brandText('{{ORGANIZATION}} policies')).toBe('Aria policies');
  });

  it('lets personal Appearance names override the installation names', () => {
    setBrandOverrides('Max', 'Acme');
    expect(brandName()).toBe('Max');
    expect(brandText('Buddy at {{ORGANIZATION}}')).toBe('Max at Acme');
  });

  it('uses the uploaded logo only when there is one', () => {
    expect(brandLogoUrl()).toContain('favicon');
    setBrand({ ...brand, has_logo: true, logo_version: 3 });
    expect(brandLogoUrl()).toBe('/branding/logo?v=3');
  });
});
