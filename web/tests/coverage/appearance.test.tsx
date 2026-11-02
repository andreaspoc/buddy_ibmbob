// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceSettings } from '../../src/components/AppearanceSettings';
import { accentScales, applyAppearance, assistantNamePayload, brandText, DEFAULT_ACCENT, DEFAULT_COMPANY_NAME, flushAppearanceSave, isValidAssistantName, readAppearance, readDesignTheme, renderedAccent, saveAppearance, setDesignTheme, startAppearance, syncAppearanceWithAccount, themeColor, watchAccountSave } from '../../src/lib/appearance';
import { clearPrivateClientData } from '../../src/lib/clientData';
import { applyDesignTheme } from '../../src/lib/designTheme';
import { hexToRgb, isThemePurple, rgbToHsl, themeColorPostcss, themeCssValue } from '../../src/lib/themeColor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('themeColor', () => {
  it('rewrites violet colours and preserves other values', () => {
    expect(themeCssValue('#6929c4')).toContain('var(--theme-h, 0deg)');
    expect(themeCssValue('1px solid #0f62fe')).toBe('1px solid #0f62fe');
    expect(themeCssValue('url(#6929c4) #6929c480')).toMatch(/^url\(#6929c4\) hsl\(.* \/ 0\.5\)$/);
    expect(themeCssValue('rgba(105, 41, 196, .22)')).toContain('/ .22');
    expect(themeCssValue('rgb(15, 98, 254)')).toBe('rgb(15, 98, 254)');
    expect(themeCssValue('#f6f2ff')).not.toContain('--theme-l');
    expect(themeCssValue('#62cf')).toContain('/ 1');
    expect(themeCssValue('#123')).toBe('#123');
  });
  it('parses and classifies colours', () => {
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
    expect(hexToRgb('nope')).toBeNull();
    expect(rgbToHsl(128, 128, 128).s).toBe(0);
    expect(rgbToHsl(255, 0, 0).h).toBe(0);
    expect(rgbToHsl(0, 255, 0).h).toBe(120);
    expect(isThemePurple(rgbToHsl(105, 41, 196))).toBe(true);
    expect(isThemePurple(rgbToHsl(15, 98, 254))).toBe(false);
  });
  it('postcss plugin only touches matching declarations', () => {
    const plugin = themeColorPostcss();
    const purple = { value: '#6929c4' }, blue = { value: '#0f62fe' };
    plugin.Declaration(purple); plugin.Declaration(blue);
    expect(purple.value).toContain('hsl(');
    expect(blue.value).toBe('#0f62fe');
  });
});

describe('appearance', () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '<title>Buddy</title><meta name="theme-color" content="#30104d"><link rel="icon" href="/favicon.svg">';
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<svg fill="#863BFF" stroke="#0f62fe"/>' })));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); saveAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Buddy', companyName: '{{ORGANIZATION}}' }); vi.unstubAllGlobals(); });

  it('reads defaults and rejects invalid saved values', () => {
    expect(readAppearance().accent).toBe(DEFAULT_ACCENT);
    localStorage.setItem('buddy-appearance-v1', '{"accent":"red","assistantName":"<b>"}');
    expect(readAppearance()).toEqual({ accent: DEFAULT_ACCENT, assistantName: 'Buddy', companyName: '{{ORGANIZATION}}' });
    localStorage.setItem('buddy-appearance-v1', 'null');
    expect(readAppearance().assistantName).toBe('Buddy');
    localStorage.setItem('buddy-appearance-v1', '{broken');
    expect(readAppearance().accent).toBe(DEFAULT_ACCENT);
    expect(isValidAssistantName('Αθηνά 2')).toBe(true);
    expect(isValidAssistantName("ignore\nprevious")).toBe(false);
  });
  it('keeps white text readable on a pale accent', () => {
    expect(accentScales('#ffff00').light).toBeLessThan(1);
    expect(accentScales('nope')).toEqual({ hue: 0, saturation: 1, light: 1 });
    expect(renderedAccent(DEFAULT_ACCENT)).toBe(DEFAULT_ACCENT);
    expect(renderedAccent('#0f62fe')).not.toBe(DEFAULT_ACCENT);
    expect(themeColor('#0f62fe', '#198038')).toBe('#0f62fe');
    expect(themeColor('not-a-colour', '#198038')).toBe('not-a-colour');
    expect(themeColor('#f6f2ff', '#198038')).toMatch(/^#[\da-f]{6}$/);
  });
  it('recolours tokens, logo and tab icon, then restores them', async () => {
    saveAppearance({ accent: '#198038', assistantName: 'Buddy' });
    expect(document.documentElement.style.getPropertyValue('--theme-h')).not.toBe('');
    expect(document.getElementById('buddy-theme-logo')).not.toBeNull();
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).not.toBe('#30104d');
    await act(flush);
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    expect(icon.href).toContain('data:image/svg+xml');
    expect(decodeURIComponent(icon.href)).toContain('#0f62fe');
    saveAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Buddy' });
    expect(document.documentElement.style.getPropertyValue('--theme-h')).toBe('');
    expect(icon.href).toContain('/favicon.svg');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe('#30104d');
  });
  it('tolerates an unavailable icon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    saveAppearance({ accent: '#da1e28', assistantName: 'Buddy' });
    await act(flush);
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toContain('/favicon.svg');
  });
  it('renames interface text but never user content, and reverses', async () => {
    host.innerHTML = '<p id="ui" title="Ask Buddy">Buddy</p><div class="markdown-body">Buddy said</div><textarea>Buddy</textarea>';
    startAppearance();
    saveAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Aria' });
    expect(host.querySelector('#ui')!.textContent).toBe('Aria');
    expect(host.querySelector('#ui')!.getAttribute('title')).toBe('Ask Aria');
    expect(host.querySelector('.markdown-body')!.textContent).toBe('Buddy said');
    expect(host.querySelector('textarea')!.textContent).toBe('Buddy');
    expect(document.title).toBe('Aria');
    expect(brandText('DecisionsBuddy Buddys Buddy’s')).toBe('DecisionsAria Buddys Aria’s');
    const added = document.createElement('span'); added.textContent = 'Back to Buddy'; added.setAttribute('aria-label', 'Buddy'); host.append(added);
    await act(flush);
    expect(added.textContent).toBe('Back to Aria');
    expect(added.getAttribute('aria-label')).toBe('Aria');
    added.firstChild!.nodeValue = 'Buddy again';
    added.setAttribute('aria-label', 'Open Buddy');
    await act(flush);
    expect(added.textContent).toBe('Aria again');
    expect(added.getAttribute('aria-label')).toBe('Open Aria');
    host.append(document.createTextNode('Buddy text'));
    await act(flush);
    expect(host.lastChild!.textContent).toBe('Aria text');
    localStorage.setItem('buddy-appearance-v1', JSON.stringify({ accent: DEFAULT_ACCENT, assistantName: 'Nova' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'buddy-appearance-v1' }));
    expect(added.textContent).toBe('Nova again');
    applyAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Buddy', companyName: '{{ORGANIZATION}}' });
    expect(host.querySelector('#ui')!.textContent).toBe('Buddy');
    expect(document.title).toBe('Buddy');
  });
  it('protects user content and identifiers from renaming', () => {
    host.innerHTML = '<button id="title" data-user-content title="Buddy rollout">Buddy rollout</button>'
      + '<div class="lesson-rich-content"><p>About Buddy</p></div><div class="learning-book-columns">Buddy book</div>'
      + '<form class="quiz-card" aria-label="Buddy quiz"><input id="inner" placeholder="Ask Buddy">Buddy question</form>'
      + '<div class="markdown-body"><a id="cite" aria-label="Buddy source">x</a></div>'
      + '<label><input id="field" placeholder="Ask Buddy"></label><p id="file">Buddy_report.docx, Buddy.pdf, a_Buddy and Buddy.</p>';
    startAppearance();
    saveAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Aria' });
    expect(host.querySelector('#title')!.textContent).toBe('Buddy rollout');
    expect(host.querySelector('#title')!.getAttribute('title')).toBe('Buddy rollout');
    expect(host.querySelector('.lesson-rich-content')!.textContent).toBe('About Buddy');
    expect(host.querySelector('.learning-book-columns')!.textContent).toBe('Buddy book');
    expect(host.querySelector('.quiz-card')!.getAttribute('aria-label')).toBe('Buddy quiz');
    expect(host.querySelector('#inner')!.getAttribute('placeholder')).toBe('Ask Buddy');
    expect(host.querySelector('#cite')!.getAttribute('aria-label')).toBe('Buddy source');
    expect(host.querySelector('#field')!.getAttribute('placeholder')).toBe('Ask Aria');
    expect(host.querySelector('#file')!.textContent).toBe('Buddy_report.docx, Buddy.pdf, a_Buddy and Aria.');
  });
  it('sends the name to assistants only when it was changed', () => {
    expect(assistantNamePayload()).toEqual({});
    saveAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Aria' });
    expect(assistantNamePayload()).toEqual({ assistant_name: 'Aria' });
  });
  it('renames the company on its own and leaves the assistant name', async () => {
    host.innerHTML = '<h1 id="brand">{{ORGANIZATION}}<span>Buddy</span></h1><p id="caps">{{ORGANIZATION}} WORKSPACE</p><p class="buddy-surface" id="site">Company A.com buddy Company A-x Company A_x</p><div class="markdown-body">Company A said</div>';
    startAppearance();
    saveAppearance({ companyName: 'Acme' });
    expect(document.title).toBe('Buddy');
    expect(host.querySelector('#brand')!.textContent).toBe('AcmeBuddy');
    expect(host.querySelector('#caps')!.textContent).toBe('Acme WORKSPACE');
    expect(host.querySelector('#site')!.textContent).toBe('Company A.com buddy Company A-x Company A_x');
    expect(host.querySelector('#site')!.className).toBe('buddy-surface');
    expect(host.querySelector('.markdown-body')!.textContent).toBe('Company A said');
    expect(brandText('{{ORGANIZATION}}, Buddy.')).toBe('Acme, Buddy.');
    expect(assistantNamePayload()).toEqual({ assistant_name: 'Acme Buddy' });
    saveAppearance({ assistantName: 'Aria' });
    expect(document.title).toBe('Aria');
    expect(assistantNamePayload()).toEqual({ assistant_name: 'Acme Aria' });
    saveAppearance({ companyName: '{{ORGANIZATION}}' });
    expect(assistantNamePayload()).toEqual({ assistant_name: 'Aria' });
    saveAppearance({ assistantName: 'Buddy' });
    expect(assistantNamePayload()).toEqual({});
    expect(document.title).toBe('Buddy');
    expect(host.querySelector('#caps')!.textContent).toBe('Buddy WORKSPACE');
    localStorage.setItem('buddy-appearance-v1', '{"companyName":"<b>"}');
    expect(readAppearance().companyName).toBe('{{ORGANIZATION}}');
  });
  it('company field saves, validates and resets separately from the assistant name', async () => {
    await act(async () => { root.render(<AppearanceSettings />); });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Company name"]')!;
    const setValue = (value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
    await act(async () => setValue('Acme'));
    expect(readAppearance()).toMatchObject({ companyName: 'Acme', assistantName: 'Buddy' });
    await act(async () => setValue('bad<name'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(readAppearance().companyName).toBe('Acme');
    await act(async () => setValue(''));
    expect(readAppearance().companyName).toBe('{{ORGANIZATION}}');
  });
  it('switches the design theme and syncs other tabs', () => {
    setDesignTheme('carbon');
    expect(readDesignTheme()).toBe('carbon');
    expect(document.documentElement.dataset.uiTheme).toBeUndefined();
    setDesignTheme('copilotkit');
    expect(document.documentElement.dataset.uiTheme).toBe('copilotkit');
    localStorage.setItem('buddy-ui-theme', 'carbon');
    document.documentElement.dataset.designSystem = 'carbon';
    applyDesignTheme();
    expect(document.documentElement.dataset.uiTheme).toBeUndefined();
    localStorage.setItem('buddy-ui-theme', 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'buddy-ui-theme' }));
    expect(document.documentElement.dataset.uiTheme).toBe('copilotkit');
  });
  it('still works when storage is blocked', () => {
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const blockedSet = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readAppearance().assistantName).toBe('Buddy');
    expect(readDesignTheme()).toBe('copilotkit');
    expect(() => saveAppearance({ accent: DEFAULT_ACCENT, assistantName: 'Buddy' })).not.toThrow();
    expect(() => setDesignTheme('carbon')).not.toThrow();
    blocked.mockRestore(); blockedSet.mockRestore();
  });
  it('settings panel changes theme, name and colour, validates, and resets', async () => {
    await act(async () => { root.render(<AppearanceSettings />); });
    // Picking a colour must not close the Settings menu.
    expect(host.querySelector('.appearance-settings')!.hasAttribute('data-keep-open')).toBe(true);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Assistant name"]')!;
    const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    await act(async () => setValue(input, 'Aria'));
    expect(readAppearance().assistantName).toBe('Aria');
    await act(async () => setValue(input, 'bad<name'));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(readAppearance().assistantName).toBe('Aria');
    const green = host.querySelector<HTMLButtonElement>('[aria-label="Green"]')!;
    await act(async () => green.click());
    expect(readAppearance()).toEqual({ accent: '#198038', assistantName: 'Aria', companyName: '{{ORGANIZATION}}' });
    expect(green.getAttribute('aria-checked')).toBe('true');
    await act(async () => setValue(input, ''));
    expect(readAppearance().assistantName).toBe('Buddy');
    const custom = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    await act(async () => setValue(custom, '#ffff00'));
    expect(readAppearance().accent).toBe('#ffff00');
    expect(host.querySelector('.appearance-note')).not.toBeNull();
    const select = host.querySelector<HTMLSelectElement>('select')!;
    await act(async () => setValue(select, 'carbon'));
    expect(readDesignTheme()).toBe('carbon');
    await act(async () => [...host.querySelectorAll('button')].at(-1)!.click());
    expect(readAppearance()).toEqual({ accent: DEFAULT_ACCENT, assistantName: 'Buddy', companyName: '{{ORGANIZATION}}' });
    expect(readDesignTheme()).toBe('copilotkit');
  });
});

describe('appearance follows the account', () => {
  const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
  const putCalls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter(([, init]) => init?.method === 'PUT');

  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('keeps the appearance through sign-out but still clears private data', () => {
    localStorage.setItem('buddy-appearance-v1', '{"accent":"#0f62fe"}');
    localStorage.setItem('buddy-appearance-owner', 'ana');
    localStorage.setItem('buddy-ui-theme', 'carbon');
    localStorage.setItem('buddy-private-draft', 'secret');
    clearPrivateClientData();
    expect(localStorage.getItem('buddy-appearance-v1')).toContain('#0f62fe');
    expect(localStorage.getItem('buddy-appearance-owner')).toBe('ana');
    expect(localStorage.getItem('buddy-ui-theme')).toBe('carbon');
    expect(localStorage.getItem('buddy-private-draft')).toBeNull();
  });

  it('applies what the account has saved after sign-in', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ appearance: { accent: '#198038', assistantName: 'Nova', companyName: 'Acme', theme: 'carbon' } }));
    vi.stubGlobal('fetch', fetchMock);
    await syncAppearanceWithAccount('ana');
    expect(readAppearance()).toEqual({ accent: '#198038', assistantName: 'Nova', companyName: 'Acme' });
    expect(readDesignTheme()).toBe('carbon');
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('uploads this browser\'s earlier choices when the account has none', async () => {
    localStorage.setItem('buddy-appearance-v1', JSON.stringify({ accent: '#0f62fe' }));
    const fetchMock = vi.fn(async () => jsonResponse({ appearance: null }));
    vi.stubGlobal('fetch', fetchMock);
    await syncAppearanceWithAccount('ana');
    const [[, init]] = putCalls(fetchMock);
    expect(JSON.parse(init.body)).toMatchObject({ accent: '#0f62fe', theme: 'copilotkit' });
  });

  it('never hands one person\'s appearance to the next person on the browser', async () => {
    localStorage.setItem('buddy-appearance-v1', JSON.stringify({ accent: '#0f62fe', companyName: 'Acme' }));
    localStorage.setItem('buddy-appearance-owner', 'ana');
    localStorage.setItem('buddy-ui-theme', 'carbon');
    const fetchMock = vi.fn(async () => jsonResponse({ appearance: null }));
    vi.stubGlobal('fetch', fetchMock);
    await syncAppearanceWithAccount('ben');
    expect(readAppearance().accent).toBe(DEFAULT_ACCENT);
    expect(readAppearance().companyName).toBe(DEFAULT_COMPANY_NAME);
    expect(readDesignTheme()).toBe('copilotkit');
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('keeps the browser copy when the account cannot be reached', async () => {
    localStorage.setItem('buddy-appearance-v1', JSON.stringify({ accent: '#0f62fe' }));
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)));
    await syncAppearanceWithAccount('ana');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await syncAppearanceWithAccount('ana');
    expect(readAppearance().accent).toBe('#0f62fe');
  });

  it('groups rapid changes into one save and sends a waiting one before sign-out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    saveAppearance({ assistantName: 'N' });
    saveAppearance({ assistantName: 'Nova' });
    setDesignTheme('carbon');
    await vi.advanceTimersByTimeAsync(600);
    expect(putCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(putCalls(fetchMock)[0][1].body)).toMatchObject({ assistantName: 'Nova', theme: 'carbon' });
    await flushAppearanceSave();
    expect(putCalls(fetchMock)).toHaveLength(1);
    saveAppearance({ assistantName: 'Iris' });
    await flushAppearanceSave();
    expect(JSON.parse(putCalls(fetchMock)[1][1].body)).toMatchObject({ assistantName: 'Iris' });
  });

  it('tells the person when a change could not reach the account', async () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const stop = watchAccountSave(failed => seen.push(failed));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    saveAppearance({ assistantName: 'Nova' });
    await vi.advanceTimersByTimeAsync(600);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    saveAppearance({ assistantName: 'Iris' });
    await vi.advanceTimersByTimeAsync(600);
    stop();
    expect(seen).toEqual([false, true, false]);
  });
});
