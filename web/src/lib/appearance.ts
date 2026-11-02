import { getBrand, setBrandOverrides } from './brand';
import { hexToRgb, isThemePurple, rgbToHsl, THEME_ANCHOR } from './themeColor';

/** Appearance belongs to the account; this browser keeps a copy so pages paint correctly before sign-in. */
export const DEFAULT_ASSISTANT_NAME = 'Buddy';
export const DEFAULT_COMPANY_NAME = '{{ORGANIZATION}}';
export const DEFAULT_ACCENT = '#6929c4';
export const ACCENT_PRESETS = [
  { name: 'Purple', value: DEFAULT_ACCENT },
  { name: 'Blue', value: '#0f62fe' },
  { name: 'Teal', value: '#007d79' },
  { name: 'Green', value: '#198038' },
  { name: 'Orange', value: '#ba4e00' },
  { name: 'Red', value: '#da1e28' },
  { name: 'Magenta', value: '#d02670' },
  { name: 'Slate', value: '#4d5358' },
] as const;
export type DesignTheme = 'copilotkit' | 'carbon';
export interface Appearance { accent: string; assistantName: string; companyName: string }

const STORAGE_KEY = 'buddy-appearance-v1';
const THEME_KEY = 'buddy-ui-theme';
const OWNER_KEY = 'buddy-appearance-owner';
const ACCOUNT_URL = '/auth/appearance';
const ACCOUNT_SAVE_DELAY_MS = 500;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,23}$/u;
const ACCENT_PATTERN = /^#[\da-f]{6}$/i;
// Skip file names and identifiers such as Buddy_report.docx, while still matching "Buddy." in a sentence.
const BRAND_WORD = /(?<![_/\\])Buddy(?![A-Za-z_])(?!\.[A-Za-z\d])/g;
const COMPANY_WORD = /\{\{ORGANIZATION\}\}/g;
const MIN_WHITE_CONTRAST = 4.5;
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
// Users' own text and generated answers are shown as written, never renamed.
const PROTECTED_CONTENT = 'script,style,textarea,input,pre,code,[contenteditable],.markdown-body,.member-chat-message p,.notes-workspace article,.sticky-note,.artifact-preview,.learning-assistant-markdown,.lesson-rich-content,.learning-book-columns,.quiz-card,[data-user-content]';

/** Chat request field with the full display name, omitted while the defaults are in use. */
export function assistantNamePayload(): { assistant_name?: string } {
  const { assistantName, companyName } = readAppearance();
  if (companyName !== DEFAULT_COMPANY_NAME) return { assistant_name: `${companyName} ${assistantName === DEFAULT_ASSISTANT_NAME ? getBrand().name : assistantName}` };
  return assistantName === DEFAULT_ASSISTANT_NAME ? {} : { assistant_name: assistantName };
}

export function isValidAssistantName(value: string): boolean { return NAME_PATTERN.test(value); }

const validName = (value: unknown, fallback: string) => typeof value === 'string' && isValidAssistantName(value) ? value : fallback;

export function readAppearance(): Appearance {
  const fallback = { accent: DEFAULT_ACCENT, assistantName: DEFAULT_ASSISTANT_NAME, companyName: DEFAULT_COMPANY_NAME };
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!stored || typeof stored !== 'object') return fallback;
    const { accent, assistantName, companyName } = stored as Partial<Appearance>;
    return {
      accent: typeof accent === 'string' && ACCENT_PATTERN.test(accent) ? accent.toLowerCase() : DEFAULT_ACCENT,
      assistantName: validName(assistantName, DEFAULT_ASSISTANT_NAME),
      companyName: validName(companyName, DEFAULT_COMPANY_NAME),
    };
  } catch { return fallback; }
}

export function readDesignTheme(): DesignTheme {
  try { return localStorage.getItem(THEME_KEY) === 'carbon' ? 'carbon' : 'copilotkit'; }
  catch { return 'copilotkit'; }
}

export function applyDesignThemeValue(theme: DesignTheme) {
  if (theme === 'copilotkit') document.documentElement.dataset.uiTheme = 'copilotkit';
  else delete document.documentElement.dataset.uiTheme;
}

export function setDesignTheme(theme: DesignTheme) {
  storeDesignTheme(theme);
  scheduleAccountSave();
}

function storeDesignTheme(theme: DesignTheme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Keep the choice for this page. */ }
  applyDesignThemeValue(theme);
}

function channelLuminance(value: number) {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const saturation = s / 100, light = l / 100;
  const chroma = saturation * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (light - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

function whiteContrast(rgb: [number, number, number]) {
  const [r, g, b] = rgb.map(channelLuminance);
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

/** Tint scales for an accent, darkened if needed so white button text stays readable. */
export function accentScales(accent: string) {
  const rgb = hexToRgb(accent);
  if (!rgb) return { hue: 0, saturation: 1, light: 1 };
  const { h, s, l } = rgbToHsl(...rgb);
  let readable = Math.max(l, 12);
  while (readable > 12 && whiteContrast(hslToRgb(h, s, readable)) < MIN_WHITE_CONTRAST) readable -= 0.5;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    hue: round(h - THEME_ANCHOR.h),
    saturation: round(s / THEME_ANCHOR.s),
    light: round(readable / THEME_ANCHOR.l),
  };
}

/** The accent as it is actually shown, after the readability adjustment. */
export function renderedAccent(accent: string): string {
  return themeColor(DEFAULT_ACCENT, accent);
}

/** For canvas, SVG and chart colours that CSS custom properties cannot reach. */
export function themeColor(color: string, accent = readAppearance().accent): string {
  const rgb = hexToRgb(color);
  if (!rgb || accent === DEFAULT_ACCENT) return color;
  const hsl = rgbToHsl(...rgb);
  if (!isThemePurple(hsl)) return color;
  const scales = accentScales(accent);
  const hue = (hsl.h + scales.hue + 360) % 360;
  const saturation = Math.min(100, hsl.s * scales.saturation);
  const light = hsl.l < 60 ? Math.min(100, hsl.l * scales.light) : hsl.l;
  return `#${hslToRgb(hue, saturation, light).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Replace the product word in interface text. */
export function brandText(text: string, names: Pick<Appearance, 'assistantName' | 'companyName'> = readAppearance()): string {
  // A person's own Appearance choice wins; otherwise use the name set for this installation.
  const assistantName = names.assistantName === DEFAULT_ASSISTANT_NAME ? getBrand().name : names.assistantName;
  const companyName = names.companyName === DEFAULT_COMPANY_NAME ? getBrand().organization || getBrand().name : names.companyName;
  const renamed = assistantName === DEFAULT_ASSISTANT_NAME ? text : text.replace(BRAND_WORD, () => assistantName);
  return renamed.replace(COMPANY_WORD, () => companyName);
}

let originalIcon = '';
let originalThemeColor = '';

function applyIcon(accent: string) {
  // An uploaded logo is the installation's icon, whatever accent colour is chosen.
  if (getBrand().has_logo) return;
  const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    originalThemeColor ||= meta.content;
    meta.content = themeColor(originalThemeColor, accent);
  }
  if (!icon) return;
  originalIcon ||= icon.href;
  if (accent === DEFAULT_ACCENT) { icon.href = originalIcon; return; }
  fetch(originalIcon).then(response => response.ok ? response.text() : Promise.reject(new Error('Icon unavailable'))).then(svg => {
    if (readAppearance().accent !== accent) return;
    const tinted = svg.replace(/#[\da-f]{6}\b/gi, color => themeColor(color, accent));
    icon.href = `data:image/svg+xml,${encodeURIComponent(tinted)}`;
  }).catch(() => { /* The default icon remains usable. */ });
}

function applyAccent(accent: string) {
  const root = document.documentElement;
  const logoStyleId = 'buddy-theme-logo';
  document.getElementById(logoStyleId)?.remove();
  if (accent === DEFAULT_ACCENT) {
    ['--theme-h', '--theme-s', '--theme-l'].forEach(token => root.style.removeProperty(token));
  } else {
    const { hue, saturation, light } = accentScales(accent);
    root.style.setProperty('--theme-h', `${hue}deg`);
    root.style.setProperty('--theme-s', String(saturation));
    root.style.setProperty('--theme-l', String(light));
    const style = document.createElement('style');
    style.id = logoStyleId;
    style.textContent = `img[src*="favicon.svg"],img[src*="project-buddy.svg"],.knowledge-hero-art svg{filter:hue-rotate(${hue}deg) saturate(${Math.min(saturation, 1.5)})}`;
    document.head.append(style);
  }
  applyIcon(accent);
}

interface Rewrite { original: string; rendered: string }
const textRewrites = new WeakMap<Text, Rewrite>();
const attributeRewrites = new WeakMap<Element, Map<string, Rewrite>>();
let everRenamed = false;
let activeNames: Pick<Appearance, 'assistantName' | 'companyName'> = { assistantName: DEFAULT_ASSISTANT_NAME, companyName: DEFAULT_COMPANY_NAME };

function nextRewrite(current: string, previous: Rewrite | undefined): Rewrite | null {
  const original = previous && current === previous.rendered ? previous.original : current;
  const rendered = brandText(original, activeNames);
  return original === rendered && !previous ? null : { original, rendered };
}

function rewriteTextNode(node: Text) {
  if (node.parentElement?.closest(PROTECTED_CONTENT)) return;
  const rewrite = nextRewrite(node.data, textRewrites.get(node));
  if (!rewrite) return;
  textRewrites.set(node, rewrite);
  if (node.data !== rewrite.rendered) node.data = rewrite.rendered;
}

function isProtectedAttributeOwner(element: Element) {
  // A field's own label and placeholder are interface text; the text typed into it is not touched.
  const owner = element.matches('input,textarea') ? element.parentElement : element;
  return Boolean(owner?.closest(PROTECTED_CONTENT));
}

function rewriteAttribute(element: Element, attribute: string) {
  if (isProtectedAttributeOwner(element)) return;
  const current = element.getAttribute(attribute);
  if (current === null) return;
  const records = attributeRewrites.get(element);
  const rewrite = nextRewrite(current, records?.get(attribute));
  if (!rewrite) return;
  const updated = records ?? new Map<string, Rewrite>();
  updated.set(attribute, rewrite);
  attributeRewrites.set(element, updated);
  if (current !== rewrite.rendered) element.setAttribute(attribute, rewrite.rendered);
}

function rewriteTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { rewriteTextNode(root as Text); return; }
  if (!(root instanceof Element)) return;
  TEXT_ATTRIBUTES.forEach(attribute => rewriteAttribute(root, attribute));
  root.querySelectorAll(TEXT_ATTRIBUTES.map(attribute => `[${attribute}]`).join(',')).forEach(element => {
    TEXT_ATTRIBUTES.forEach(attribute => rewriteAttribute(element, attribute));
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) rewriteTextNode(node as Text);
}

function applyNames(names: Pick<Appearance, 'assistantName' | 'companyName'>) {
  activeNames = names;
  setBrandOverrides(names.assistantName === DEFAULT_ASSISTANT_NAME ? null : names.assistantName, names.companyName === DEFAULT_COMPANY_NAME ? null : names.companyName);
  if (names.assistantName !== DEFAULT_ASSISTANT_NAME || names.companyName !== DEFAULT_COMPANY_NAME || getBrand().name !== DEFAULT_ASSISTANT_NAME || getBrand().organization) everRenamed = true;
  if (everRenamed) rewriteTree(document.documentElement);
}

export function applyAppearance(appearance = readAppearance()) {
  applyAccent(appearance.accent);
  applyNames(appearance);
}

function storeAppearance(appearance: Appearance) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance)); } catch { /* Keep the choice for this page. */ }
  applyAppearance(appearance);
}

export function saveAppearance(changes: Partial<Appearance>) {
  storeAppearance({ ...readAppearance(), ...changes });
  scheduleAccountSave();
}

let accountSaveTimer: ReturnType<typeof setTimeout> | undefined;
let accountSaveFailed = false;
const accountSaveListeners = new Set<(failed: boolean) => void>();

function reportAccountSave(failed: boolean) {
  accountSaveFailed = failed;
  accountSaveListeners.forEach(listener => listener(failed));
}

/** Tells the settings form whether the latest change reached the account. */
export function watchAccountSave(listener: (failed: boolean) => void): () => void {
  accountSaveListeners.add(listener);
  listener(accountSaveFailed);
  return () => { accountSaveListeners.delete(listener); };
}

async function sendToAccount() {
  try {
    const response = await fetch(ACCOUNT_URL, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...readAppearance(), theme: readDesignTheme() }),
    });
    reportAccountSave(!response.ok);
  } catch { reportAccountSave(true); }
}

// Typing a name would otherwise send one request per key press.
function scheduleAccountSave() {
  clearTimeout(accountSaveTimer);
  accountSaveTimer = setTimeout(() => { accountSaveTimer = undefined; void sendToAccount(); }, ACCOUNT_SAVE_DELAY_MS);
}

/** Send a change still waiting on the delay. Sign-out awaits this, while the session is still valid. */
export async function flushAppearanceSave() {
  if (accountSaveTimer === undefined) return;
  clearTimeout(accountSaveTimer);
  accountSaveTimer = undefined;
  await sendToAccount();
}

function readOwner() {
  try { return localStorage.getItem(OWNER_KEY); } catch { return null; }
}

function writeOwner(username: string) {
  try { localStorage.setItem(OWNER_KEY, username); } catch { /* The account remains the source of truth. */ }
}

function isCustomised() {
  const { accent, assistantName, companyName } = readAppearance();
  return accent !== DEFAULT_ACCENT || assistantName !== DEFAULT_ASSISTANT_NAME || companyName !== DEFAULT_COMPANY_NAME || readDesignTheme() !== 'copilotkit';
}

function isStoredAppearance(value: unknown): value is Appearance & { theme: DesignTheme } {
  return Boolean(value) && typeof value === 'object';
}

/**
 * Show the account's appearance after sign-in. An account with nothing saved takes this
 * browser's choices only if they are its own, never those of the previous person here.
 */
export async function syncAppearanceWithAccount(username: string) {
  let saved: unknown;
  try {
    const response = await fetch(ACCOUNT_URL);
    if (!response.ok) return;
    saved = (await response.json()).appearance;
  } catch { return; }
  const owner = readOwner();
  writeOwner(username);
  if (isStoredAppearance(saved)) {
    const { theme, ...appearance } = saved;
    storeDesignTheme(theme === 'carbon' ? 'carbon' : 'copilotkit');
    storeAppearance(appearance);
  } else if (owner && owner !== username) {
    storeDesignTheme('copilotkit');
    storeAppearance({ accent: DEFAULT_ACCENT, assistantName: DEFAULT_ASSISTANT_NAME, companyName: DEFAULT_COMPANY_NAME });
  } else if (isCustomised()) {
    await sendToAccount();
  }
}

let started = false;
/** Apply saved appearance, then keep new interface text and other tabs in step. */
export function startAppearance() {
  applyAppearance();
  if (started) return;
  started = true;
  new MutationObserver(mutations => {
    if (!everRenamed) return;
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') rewriteTextNode(mutation.target as Text);
      else if (mutation.type === 'attributes') rewriteAttribute(mutation.target as Element, mutation.attributeName!);
      else mutation.addedNodes.forEach(rewriteTree);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: TEXT_ATTRIBUTES });
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) applyAppearance();
    if (event.key === THEME_KEY && document.documentElement.dataset.designSystem) applyDesignThemeValue(readDesignTheme());
  });
}
