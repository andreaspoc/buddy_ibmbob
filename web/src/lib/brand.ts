/** Instance name and logo set in the first-run wizard. Read once at startup; saving reloads the page. */
export interface Brand {
  name: string;
  organization: string;
  has_logo: boolean;
  logo_version: number;
  // Defaults to true so a failed request can never trap users behind the wizard.
  setup_complete: boolean;
}

const DEFAULT_BRAND: Brand = { name: 'Buddy', organization: '', has_logo: false, logo_version: 0, setup_complete: true };
const DEFAULT_LOGO = '/favicon.svg?v=1';
// "Office Buddy" and similar are product module names, and stay as they are.
const ASSISTANT_WORD = /(?<![\p{L}\p{N}_-])(?<!Office )(?<!Project )(?<!Notes )(?<!People )(?<!Learning )(?<!Decisions )Buddy(?![\p{L}\p{N}_-])(?! (?:Office|Decisions|Projects|Tetragon)\b)/gu;

// Eyebrow labels are written in capitals.
const UPPERCASE_WORD = /(?<![\p{L}\p{N}_-])(?<!OFFICE )(?<!PROJECT )(?<!NOTES )(?<!PEOPLE )(?<!LEARNING )(?<!DECISIONS )BUDDY(?![\p{L}\p{N}_-])/gu;

let brand = DEFAULT_BRAND;

export const getBrand = (): Brand => brand;
let assistantOverride: string | null = null;
let organizationOverride: string | null = null;

/** Personal names from Appearance take priority over the installation's names. */
export function setBrandOverrides(assistant: string | null, organization: string | null): void {
  assistantOverride = assistant;
  organizationOverride = organization;
}

export const brandName = (): string => assistantOverride ?? brand.name;
export const brandLogoUrl = (): string => brand.has_logo ? `/branding/logo?v=${brand.logo_version}` : DEFAULT_LOGO;

export function brandText(text: string): string {
  const name = brandName();
  const organization = organizationOverride ?? (brand.organization || name);
  const withOrganization = text.split('{{ORGANIZATION}}').join(organization);
  if (name === DEFAULT_BRAND.name) return withOrganization;
  return withOrganization.replace(ASSISTANT_WORD, () => name).replace(UPPERCASE_WORD, () => name.toUpperCase());
}

export function setBrand(next: Brand): void {
  brand = next;
  if (typeof document === 'undefined') return;
  document.title = next.name;
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', brandLogoUrl());
}

export async function loadBrand(): Promise<void> {
  try {
    const response = await fetch('/branding');
    if (response.ok) setBrand({ ...DEFAULT_BRAND, ...await response.json() });
  } catch {
    // Keep the default brand; the sign-in page still works and reports connection problems.
  }
}
