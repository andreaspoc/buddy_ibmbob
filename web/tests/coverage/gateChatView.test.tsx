// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deckApi = vi.hoisted(() => ({ fetchDeckByPath: vi.fn() }));
vi.mock('../../src/api', () => deckApi);
vi.mock('../../src/mods', () => ({ modRegistry: { getActiveCommands: () => [{ command: '/modcmd', description: 'Mod command', modName: 'M', modIcon: 'x' }] } }));
vi.mock('../../src/components/MarkdownView', () => ({ MarkdownView: ({ content, onPrompt, isStreaming }: any) => <div className="fake-md" data-prompt={String(Boolean(onPrompt))} data-streaming={String(Boolean(isStreaming))}>{content}</div> }));
vi.mock('../../src/components/VoiceChat', () => ({ VoiceChat: (p: any) => <div className="fake-voice" data-read={p.readRequest?.text ?? ''}><button onClick={() => p.onSend('spoken')}>Voice send</button><button onClick={() => p.onActiveChange(true)}>Voice active</button></div> }));
vi.mock('../../src/components/VoiceInput', () => ({ VoiceInput: (p: any) => <button type="button" disabled={p.disabled} onClick={() => p.onTranscript('dictated')}>Dictate</button> }));
vi.mock('../../src/components/ChatTextSelection', () => ({ ChatTextSelection: (p: any) => <><button onClick={() => p.onQuote('quoted one\nline two')}>Quote one</button><button onClick={() => p.onQuote('quoted two')}>Quote two</button></> }));
vi.mock('../../src/components/StickyNotes', () => ({ StickyNotes: ({ notes }: any) => <div className="fake-notes">{notes.length} notes</div> }));
vi.mock('../../src/components/QuizCard', () => ({ QuizCard: (p: any) => <div className="fake-quiz"><button onClick={() => p.onSubmit('Quiz submission: answers')}>Submit quiz</button>{p.onViewResults && <button onClick={p.onViewResults}>View results</button>}</div> }));
vi.mock('../../src/components/QuizResultsCard', () => ({ QuizResultsCard: (p: any) => <button onClick={() => p.onPractice('practice')}>Practice</button> }));
vi.mock('../../src/components/ClarificationCard', () => ({ ClarificationCard: (p: any) => <div className="fake-clarify" data-answered={String(p.answered)} data-cancelled={String(p.cancelled)} data-disabled={String(p.disabled)}>{p.questions[0].question}<button onClick={() => p.onReply('my reply')}>Reply</button></div> }));
vi.mock('../../src/components/ApprovalControls', () => ({ ApprovalCard: (p: any) => <button disabled={p.disabled} onClick={() => p.onDecide(p.approval, 'approve')}>Approve {p.approval.approval_id}</button> }));
vi.mock('../../src/components/AnswerContext', () => ({ AnswerContext: ({ progressSummary }: any) => <div className="fake-context">{progressSummary}</div> }));
vi.mock('../../src/components/AnswerFeedback', () => ({ AnswerFeedback: ({ answerIndex }: any) => <div className="fake-feedback">{answerIndex}</div> }));
vi.mock('../../src/components/ShareToPeople', () => ({ ShareToPeopleButton: () => <div className="fake-share" /> }));
vi.mock('../../src/components/SkillPicker', () => ({ SkillPicker: (p: any) => <div className="fake-skills" data-selected={p.selected.join(',')}>{p.skills.map((s: any) => <button key={s.name} onClick={() => p.onSelect(s.name)}>Pick {s.name}</button>)}<input aria-label="Skill search" /></div> }));
vi.mock('../../src/components/AgentPicker', () => ({ AgentPicker: (p: any) => <div className="fake-agents"><button onClick={() => p.onChange(['a1'])}>Attach a1</button><button onClick={() => p.onChange([])}>Detach all</button><input aria-label="Agent search" /></div> }));
vi.mock('../../src/components/ShortcutsModal', () => ({ ShortcutsModal: ({ isOpen, onClose }: any) => isOpen ? <button onClick={onClose}>Close shortcuts</button> : null }));
vi.mock('../../src/components/SlideCountPicker', () => ({ SlideCountPicker: ({ value }: any) => <div className="fake-slides">{value}</div> }));
vi.mock('../../src/components/AppCollaborationActivity', () => ({ AppCollaborationActivity: () => null, collaborationFromWorkLog: () => [] }));
vi.mock('../../src/lib/quiz', () => ({
  parseQuizzes: (text: string, _s?: boolean) => ({ text, quizzes: text.includes('QUIZ1') ? [{ key: 'q1' }] : [], error: text.includes('QUIZERR') }),
  parseQuizResults: (text: string) => ({ text, results: text.includes('RESULT1') ? [{ quiz_key: 'q1' }] : [], error: text.includes('REVIEWERR') }),
  quizAttempt: () => undefined,
}));
import { ChatView, extractThinking } from '../../src/components/ChatView';

class FakeResize { static list: FakeResize[] = []; observe = vi.fn(); disconnect = vi.fn(); constructor(public cb: () => void) { FakeResize.list.push(this); } }
const SKILLS = ['research-buddy', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(name => ({ name, description: `${name} desc` }));
const assistant = (content: string, extra: Record<string, unknown> = {}) => ({ id: 'a1', role: 'assistant', content, ...extra });
const user = (content: string, extra: Record<string, unknown> = {}) => ({ id: 'u1', role: 'user', content, ...extra });
const readyFile = { path: 'dir/f.pdf', filename: 'f.pdf', size: 2048, session_id: 's1' };
const longAnswer = 'A sufficiently long answer for actions to appear.';

let host: HTMLDivElement; let root: Root; let props: any; let capabilities: () => any; let requests: Array<{ url: string; method: string }>; let docResponse: () => any;
const render = async (extra: Record<string, unknown> = {}) => { props = { ...props, ...extra }; await act(async () => { root.render(<ChatView {...props} />); await Promise.resolve(); }); };
const $ = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
const $$ = (s: string) => [...host.querySelectorAll<HTMLElement>(s)];
const byText = (text: string) => $$('button').find(b => b.textContent?.trim() === text)!;
const has = (text: string) => host.textContent!.includes(text);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); await Promise.resolve(); });
const textarea = () => $<HTMLTextAreaElement>('#prompt-input')!;
const type = (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value); textarea().dispatchEvent(new Event('input', { bubbles: true })); });
const press = (key: string, init: KeyboardEventInit = {}, target: Element = textarea()) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); await Promise.resolve(); });
const send = () => act(async () => { $('form.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });
const select = (label: string, value: string) => act(async () => { const el = $<HTMLSelectElement>(`select[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); });
const pick = (file: File) => act(async () => { const input = $<HTMLInputElement>('#chat-file-input')!; Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
const sized = (name: string, mb: number) => { const file = new File(['x'], name); Object.defineProperty(file, 'size', { value: mb * 1024 * 1024 }); return file; };
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  FakeResize.list = []; vi.stubGlobal('ResizeObserver', FakeResize);
  capabilities = () => ({ ok: true, json: async () => ({ web_search: true }) });
  docResponse = () => ({ ok: true, status: 200, json: async () => ({ status: 'ready' }) });
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { requests.push({ url, method: init?.method || 'GET' }); return url.includes('capabilities') ? capabilities() : docResponse(); }));
  deckApi.fetchDeckByPath.mockReset().mockResolvedValue(null);
  window.matchMedia = vi.fn().mockImplementation(q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  (globalThis as any).matchMedia = window.matchMedia;
  HTMLElement.prototype.scrollTo = vi.fn(); Element.prototype.scrollIntoView = vi.fn();
  (globalThis as any).CSS = { escape: (v: string) => v };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  props = { messages: [], sessionId: 's1', isStreaming: false, activeMode: 'chat', slideCount: 8, onSlideCountChange: vi.fn(), activeAgent: '', modes: [{ slug: 'code', name: 'Code', description: 'Code mode' }], skills: SKILLS, agents: [{ slug: 'a1', name: 'Agent One', description: '', endpoint: 'https://agent.example.test' }], templates: [{ id: 't1', title: 'Tpl One' }], selectedTemplateId: 't1', onSendMessage: vi.fn(), onApprovalDecision: vi.fn(), onUploadFile: vi.fn(async () => readyFile), onStop: vi.fn(), onOpenTemplateModal: vi.fn() };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('extractThinking', () => {
  it.each([
    ['', false, '', ''],
    ['<think>a</think> rest', false, 'a', 'rest'],
    ['<thinking>b</thinking>rest', true, 'b', 'rest'],
    ['before <think>open', true, 'open', 'before'],
    ['before <think>open', false, '', 'before <think>open'],
    ['plain', true, '', 'plain'],
  ])('parses %j', (content, streaming, thoughts, cleanText) => {
    expect(extractThinking(content, streaming)).toEqual({ thoughts, cleanText });
  });
});

describe('context bar', () => {
  it('selects project, mode and agent', async () => {
    const onSelectProject = vi.fn(), onChangeMode = vi.fn(), onChangeAgent = vi.fn();
    await render({ onSelectProject, onChangeMode, onChangeAgent, projects: [{ id: 'p1', name: 'P1' }] });
    await select('Conversation project', 'p1');
    await select('Conversation mode', 'code');
    await select('Conversation agent', 'a1');
    expect(onSelectProject).toHaveBeenCalledWith('p1');
    expect(onChangeMode).toHaveBeenCalledWith('code');
    expect(onChangeAgent).toHaveBeenCalledWith('a1');
  });
  it('offers change-project button and static chip', async () => {
    const onChangeProject = vi.fn();
    await render({ onChangeProject, projectName: 'Alpha' });
    await click(byText('ProjectAlpha'));
    expect(onChangeProject).toHaveBeenCalled();
    await render({ onChangeProject: undefined, projectName: undefined });
    expect($('.chat-context-chip strong')?.textContent).toBe('Personal');
  });
  it('shows unknown mode labels and connection counts', async () => {
    const onManageTools = vi.fn();
    await render({ activeMode: 'custom', configuredTools: ['x', 'y'], onManageTools });
    expect($<HTMLSelectElement>('select[aria-label="Conversation mode"]')!.value).toBe('custom');
    const tools = byText('Available connections2');
    expect(tools.title).toBe('x, y');
    await click(tools);
    expect(onManageTools).toHaveBeenCalled();
    await render({ activeMode: '', configuredTools: [], onManageTools: undefined });
    expect(has('Automatic')).toBe(true);
    expect($$('button').find(b => b.title === 'No connections configured')?.hasAttribute('disabled')).toBe(true);
  });
  it('is hidden in read-only, along with the composer', async () => {
    await render({ readOnly: true });
    expect($('.composer-wrap')).toBeNull();
    expect($('select[aria-label="Conversation mode"]')).toBeNull();
    expect($('#chat-skill-picker')).toBeNull();
  });
  it('renders presentation banner with fallback template and picker', async () => {
    await render({ activeMode: 'presentation', selectedTemplateId: 'none' });
    expect($('.template-name-highlight')?.textContent).toBe('Purple Starter');
    await click(byText('Change Template'));
    expect(props.onOpenTemplateModal).toHaveBeenCalled();
    expect(textarea().placeholder).toContain('Describe the presentation');
    await render({ selectedTemplateId: 't1' });
    expect($('.template-name-highlight')?.textContent).toBe('Tpl One');
  });
});

describe('outline', () => {
  const outlined = [user('[Attached file: a.txt]\nQuestion one'), user('Quiz submission: x', { id: 'hidden' }), user('', { id: 'u2', displayPrompt: '[Attached file: b.txt]' }), assistant('See [Report](out/report.pdf) and [Web](https://example.test/a.pdf) and [Report](out/report.pdf).'), assistant('x', { id: 'a2', deckJson: { slides: [] } })];
  it('lists prompts and artifacts, de-duplicated, and jumps to them', async () => {
    await render({ messages: outlined });
    await click($('.chat-outline-toggle')!);
    const entries = $$('#chat-conversation-outline button').map(b => b.textContent);
    expect(entries).toEqual(['PromptQuestion one', 'PromptAttached file', 'ArtifactReport', 'ArtifactPresentation']);
    const target = document.getElementById('chat-message-u1')!;
    const focus = vi.spyOn(target, 'focus');
    await click($('#chat-conversation-outline button')!);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    await click($('.chat-outline-toggle')!);
    expect($('#chat-conversation-outline')).toBeNull();
  });
  it('honours reduced motion', async () => {
    (window.matchMedia as any).mockImplementation(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    await render({ messages: [user('Hello')] });
    await click($('.chat-outline-toggle')!);
    await click($('#chat-conversation-outline button')!);
    expect((HTMLElement.prototype.scrollTo as any).mock.calls[0][0].behavior).toBe('instant');
  });
});

describe('sending', () => {
  it('sends with Enter but not Shift+Enter or IME', async () => {
    await render();
    await type('Hello');
    await press('Enter', { shiftKey: true });
    await press('Enter', { isComposing: true });
    expect(props.onSendMessage).not.toHaveBeenCalled();
    await press('Enter');
    expect(props.onSendMessage).toHaveBeenCalledWith('Hello', undefined, undefined, undefined, undefined);
    expect(textarea().value).toBe('');
  });
  it('ignores empty messages', async () => {
    await render();
    await type('   ');
    await send();
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect($<HTMLButtonElement>('.send-button')!.disabled).toBe(true);
  });
  it('appends quoted text and de-duplicates quotes', async () => {
    await render();
    await click(byText('Quote one'));
    await click(byText('Quote one'));
    await click(byText('Quote two'));
    expect($$('.composer-quote')).toHaveLength(2);
    expect(textarea().placeholder).toBe('Ask a question about the selected text…');
    await click($('.composer-quote button')!);
    await click(byText('Quote one'));
    await type('Explain');
    await send();
    expect(props.onSendMessage.mock.calls[0][0]).toBe('Explain\n\nSelected text:\n> quoted two\n\n> quoted one\n> line two');
    expect($('.composer-quote')).toBeNull();
  });
  it('sends with multiple selected skills', async () => {
    await render();
    await select('Select skill', 'alpha');
    await select('Select skill', 'beta');
    expect($('.composer-skill-summary')?.textContent).toContain('2 / 6 Skills');
    expect(textarea().placeholder).toContain('Ask');
    await type('Go');
    await send();
    expect(props.onSendMessage.mock.calls[0][4]).toEqual(['alpha', 'beta']);
  });
  it('limits to six skills, removes and clears them', async () => {
    await render();
    for (const name of SKILLS.map(s => s.name)) await select('Select skill', name);
    expect($('.composer-skill-summary')?.textContent).toContain('6 / 6');
    const blocked = $<HTMLSelectElement>('select[aria-label="Select skill"]')!.querySelector<HTMLOptionElement>('option[value="zeta"]')!;
    expect(blocked.disabled).toBe(true);
    await select('Select skill', 'alpha');
    expect($('.composer-skill-summary')?.textContent).toContain('5 / 6');
    await click($('.composer-skill-summary button')!);
    expect($('.composer-skill-summary')?.textContent).toContain('4 / 6');
    await click(byText('Clear skills'));
    expect($('.composer-skill-summary')).toBeNull();
  });
  it('clears agent when choosing a skill and resets selection across sessions', async () => {
    const onChangeAgent = vi.fn();
    await render({ onChangeAgent });
    await click(byText('Pick alpha'));
    expect(onChangeAgent).toHaveBeenCalledWith('');
    expect($('.fake-skills')?.dataset.selected).toBe('alpha');
    await render({ sessionId: 's2' });
    expect($('.fake-skills')?.dataset.selected).toBe('');
  });
  it('preselects guided skill for its session', async () => {
    await render({ guidedSkill: { sessionId: 's1', name: 'beta' } });
    expect($('.chat-context-chip strong')?.textContent).toBeTruthy();
    expect($('.fake-skills')?.dataset.selected).toBe('beta');
  });
  it('routes web search through research buddy when active', async () => {
    await render();
    await flush();
    const toggle = $<HTMLButtonElement>('.composer-websearch-btn')!;
    await click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(has('Web search on')).toBe(true);
    expect(textarea().placeholder).toBe('Search the live web with Brave…');
    await type('find me');
    await send();
    expect(props.onSendMessage.mock.calls[0][0]).toBe('/research-buddy find me');
    await type('/raw');
    await send();
    expect(props.onSendMessage.mock.calls[1][0]).toBe('/raw');
  });
  it.each([
    ['unavailable capabilities', () => ({ ok: false, json: async () => ({}) })],
    ['disabled search', () => ({ ok: true, json: async () => ({ web_search: false }) })],
  ])('disables web search on %s', async (_n, response) => {
    capabilities = response;
    await render();
    await flush();
    const toggle = $<HTMLButtonElement>('.composer-websearch-btn')!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toContain('BRAVE_API_KEY');
  });
  it('appends dictation with spacing', async () => {
    await render();
    await click(byText('Dictate'));
    await click(byText('Dictate'));
    expect(textarea().value).toBe('dictated dictated');
  });
  it('voice sends through skill, voice handler or default', async () => {
    const onVoiceSend = vi.fn();
    await render({ onVoiceSend });
    await click(byText('Voice send'));
    expect(onVoiceSend).toHaveBeenCalledWith('spoken');
    await render({ onVoiceSend: undefined });
    await click(byText('Voice send'));
    expect(props.onSendMessage).toHaveBeenCalledWith('spoken');
    await click(byText('Pick alpha'));
    await click(byText('Voice send'));
    expect(props.onSendMessage).toHaveBeenLastCalledWith('spoken', undefined, undefined, undefined, 'alpha');
    await click(byText('Voice active'));
    expect(byText('Dictate').disabled).toBe(true);
  });
  it('shows contextual placeholder for active agent', async () => {
    await render({ activeAgent: 'a1' });
    expect(textarea().placeholder).toBe('Message Agent One…');
    expect($('label[for=prompt-input]')?.textContent).toBe('Message Agent One');
  });
});

describe('slash menu', () => {
  const heads = () => $$('.slash-menu-heading').map(h => h.textContent);
  it('opens from typing, filters, and inserts choices', async () => {
    await render();
    await type('/alph');
    expect($$('.slash-option').map(o => o.querySelector('small')?.textContent)).toEqual(['alpha desc']);
    await click($('.slash-option')!);
    expect(textarea().value).toBe('/alpha ');
    expect($('.slash-menu')).toBeNull();
  });
  it('reports no skill match', async () => {
    await render();
    await type('/zzzz');
    expect(heads()).toContain('No matching skills');
    expect(heads()).not.toContain('WORKSPACE & EXTENSIONS');
  });
  it.each([['/mode', '/mode code '], ['/agent', '/agent a1 '], ['/modcmd', '/modcmd '], ['/preview', '/preview ']])('inserts %s command', async (query, inserted) => {
    await render();
    await type(query);
    await click($('.slash-option')!);
    expect(textarea().value).toBe(inserted);
  });
  it('labels studio and mod commands', async () => {
    await render();
    await click($('.slash-button')!);
    const kinds = $$('.slash-option-kind').map(k => k.textContent);
    expect(kinds).toEqual(expect.arrayContaining(['SKILL', 'MODE', 'A2A', 'STUDIO', 'MOD']));
  });
  it('supports keyboard selection and closing', async () => {
    await render();
    await type('/alpha');
    await press('ArrowDown');
    expect(document.activeElement).toBe($('.slash-option'));
    const menu = $('.slash-menu')!;
    await press('ArrowDown', {}, document.activeElement!);
    await press('ArrowUp', {}, document.activeElement!);
    expect(document.activeElement).toBe($('.slash-option'));
    await press('Escape', {}, document.activeElement!);
    expect($('.slash-menu')).toBeNull();
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(textarea());
  });
  it('Enter and Tab pick the first option; Escape in input closes', async () => {
    await render();
    await type('/alpha');
    await press('Enter');
    expect(textarea().value).toBe('/alpha ');
    await type('/beta');
    await press('Tab');
    expect(textarea().value).toBe('/beta ');
    await type('/g');
    await press('Escape');
    expect($('.slash-menu')).toBeNull();
    expect(props.onSendMessage).not.toHaveBeenCalled();
  });
  it('closes when streaming starts', async () => {
    await render();
    await click($('.slash-button')!);
    expect($('.slash-menu')).not.toBeNull();
    await render({ isStreaming: true });
    expect($('.slash-menu')).toBeNull();
  });
});

describe('global shortcuts', () => {
  const global = (key: string, init: KeyboardEventInit = {}) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
  it('toggles the sheet, focuses composer, and closes with Escape', async () => {
    await render();
    await global('/', { ctrlKey: true });
    expect(byText('Close shortcuts')).toBeTruthy();
    await global('Escape');
    expect(byText('Close shortcuts')).toBeUndefined();
    await global('/', { metaKey: true });
    await click(byText('Close shortcuts'));
    expect(byText('Close shortcuts')).toBeUndefined();
    await click($('.composer-shortcuts-btn')!);
    expect(byText('Close shortcuts')).toBeTruthy();
    await global('k', { metaKey: true });
    expect(document.activeElement).toBe(textarea());
  });
});

describe('attachments', () => {
  it.each([['doc.pdf', 26, 25], ['data.csv', 51, 50]])('rejects oversized %s', async (name, mb, limit) => {
    await render();
    await pick(sized(name, mb));
    expect($('.composer-upload-error')?.textContent).toContain(`The limit is ${limit} MB.`);
    expect(props.onUploadFile).not.toHaveBeenCalled();
    await click($('.composer-upload-error button')!);
    expect($('.composer-upload-error')).toBeNull();
  });
  it('uploads, suggests a prompt, shows spreadsheet summary and sends prefix', async () => {
    const onFilesChanged = vi.fn();
    props.onUploadFile = vi.fn(async () => ({ ...readyFile, filename: 's.csv', is_spreadsheet: true, summary: { total_rows: 1200, sheets_count: 2 } }));
    await render({ onFilesChanged });
    await pick(new File(['x'], 's.csv'));
    expect(onFilesChanged).toHaveBeenCalled();
    expect(textarea().value).toContain('Please inspect s.csv');
    expect($('.attached-chip-info')?.textContent).toMatch(/rows/);
    expect($('.attached-chip-info')?.textContent).toContain('2 sheets');
    expect($('.upload-complete-mark')?.textContent?.trim()).toBe('✓');
    await send();
    expect(props.onSendMessage.mock.calls[0][0]).toMatch(/^\[Attached spreadsheet: s\.csv\]\n/);
  });
  it('sends file with a default prompt, including quotes', async () => {
    await render();
    await type('keep this');
    await pick(new File(['x'], 'f.txt'));
    expect(textarea().value).toBe('keep this');
    await type('');
    await click(byText('Quote two'));
    await send();
    expect(props.onSendMessage.mock.calls[0][0]).toContain('[Attached file: f.pdf]\nPlease inspect the attached file');
    expect(props.onSendMessage.mock.calls[0][0]).toContain('> quoted two');
  });
  it('shows pending upload and blocks a second upload', async () => {
    let finish = (_: unknown) => {};
    props.onUploadFile = vi.fn(() => new Promise(r => { finish = r; }));
    await render();
    await pick(new File(['x'], 'slow.pdf'));
    expect($('.upload-pending')?.textContent).toContain('slow.pdf');
    expect($('.composer-clip-btn .step-spinner')).not.toBeNull();
    await pick(new File(['x'], 'other.pdf'));
    expect(props.onUploadFile).toHaveBeenCalledOnce();
    await act(async () => { finish(readyFile); await flush(); });
    expect($('.upload-pending')).toBeNull();
  });
  it('reports upload errors, with fallback, ignoring stale sessions', async () => {
    props.onUploadFile = vi.fn().mockRejectedValueOnce(new Error('Too big')).mockRejectedValueOnce({});
    await render();
    await pick(new File(['x'], 'a.txt'));
    expect($('.composer-upload-error')?.textContent).toContain('Too big');
    await pick(new File(['x'], 'a.txt'));
    expect($('.composer-upload-error')?.textContent).toContain('Failed to upload file');
  });
  it('discards upload that completes after session change', async () => {
    let finish = (_: unknown) => {};
    props.onUploadFile = vi.fn(() => new Promise(r => { finish = r; }));
    await render();
    await pick(new File(['x'], 'a.txt'));
    await render({ sessionId: 's2' });
    await act(async () => { finish({ ...readyFile, session_id: 'other' }); await flush(); });
    expect($('.attached-chip:not(.upload-pending)')).toBeNull();
    expect(textarea().value).toBe('');
  });
  it('supports drag and drop', async () => {
    await render();
    const form = $('form.composer')!;
    const drag = (type: string, files: File[] = []) => act(async () => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { files } }); form.dispatchEvent(event); await flush(); });
    await drag('dragover');
    expect(form.className).toContain('drag-over');
    await drag('dragleave');
    expect(form.className).not.toContain('drag-over');
    await drag('drop');
    expect(props.onUploadFile).not.toHaveBeenCalled();
    await drag('drop', [new File(['x'], 'dropped.txt')]);
    expect(props.onUploadFile).toHaveBeenCalled();
  });
  it('removes attachment and views it from chip', async () => {
    const onViewAttachment = vi.fn();
    await render({ onViewAttachment });
    await pick(new File(['x'], 'f.txt'));
    await click($('.chat-context-file')!);
    expect(onViewAttachment).toHaveBeenCalledWith('dir/f.pdf');
    await click($('.attached-chip-remove')!);
    expect($('.attached-chip')).toBeNull();
  });
  it('clicks through the clip button', async () => {
    await render();
    const clicked = vi.spyOn($<HTMLInputElement>('#chat-file-input')!, 'click').mockImplementation(() => {});
    await click($('.composer-clip-btn')!);
    expect(clicked).toHaveBeenCalled();
  });
});

describe('document preparation', () => {
  const docFile = (status: string, extra = {}) => ({ ...readyFile, document: { path: readyFile.path, status, ...extra } });
  const attach = async (status: string, extra = {}) => { props.onUploadFile = vi.fn(async () => docFile(status, extra)); await render(); await pick(new File(['x'], 'f.pdf')); };
  it('polls until ready and unlocks sending', async () => {
    let status = 'processing';
    docResponse = () => ({ ok: true, status: 200, json: async () => ({ status }) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onFilesChanged = vi.fn();
    props.onUploadFile = vi.fn(async () => docFile('queued'));
    await render({ onFilesChanged });
    await act(async () => { await pick(new File(['x'], 'f.pdf')); await vi.advanceTimersByTimeAsync(0); });
    expect($('.upload-complete-mark')?.textContent?.trim()).toBe('⋯');
    expect(has('You can send your message when the document is ready')).toBe(true);
    expect($<HTMLButtonElement>('.send-button')!.disabled).toBe(true);
    await send();
    expect(props.onSendMessage).not.toHaveBeenCalled();
    status = 'ready';
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect($('.attached-chip-badge')?.textContent).toBe('Ready');
    expect(onFilesChanged).toHaveBeenCalledTimes(2);
    await send();
    expect(props.onSendMessage.mock.calls[0][0]).toMatch(/^\[Attached document: f\.pdf\]/);
  });
  it.each([
    [404, 'This document is no longer available.'],
    [401, 'Document access could not be verified.'],
    [403, 'Document access could not be verified.'],
  ])('stops polling on %i', async (status, text) => {
    docResponse = () => ({ ok: false, status, json: async () => ({}) });
    await attach('queued');
    await flush();
    expect(has(text)).toBe(true);
  });
  it('retries polling with backoff after server errors', async () => {
    docResponse = () => ({ ok: false, status: 500, json: async () => ({}) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    props.onUploadFile = vi.fn(async () => docFile('queued'));
    await render();
    await act(async () => { await pick(new File(['x'], 'f.pdf')); await vi.advanceTimersByTimeAsync(0); });
    expect(has('Retrying automatically')).toBe(true);
    const polls = () => requests.filter(r => r.url.includes('documents/preview')).length;
    const first = polls();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(polls()).toBeGreaterThan(first);
    docResponse = () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', error: 'Corrupt' }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(has('Corrupt')).toBe(true);
    expect(has('Retrying automatically')).toBe(false);
  });
  it('retries failed preparation and handles failure', async () => {
    await attach('failed');
    expect($('.upload-complete-mark')?.textContent?.trim()).toBe('!');
    expect(has('This document could not be prepared.')).toBe(true);
    docResponse = () => ({ ok: false, status: 500, json: async () => ({}) });
    await click(byText('Retry preparation'));
    await flush();
    expect(has('Could not retry document preparation. Please try again.')).toBe(true);
    docResponse = () => ({ ok: true, status: 200, json: async () => ({ status: 'failed' }) });
    await click(byText('Retry preparation'));
    await flush();
    expect(requests.filter(r => r.url.includes('documents/prepare') && r.method === 'POST')).toHaveLength(2);
    expect(requests.some(r => r.url.includes('documents/preview'))).toBe(true);
  });
  it('offers document view when supported', async () => {
    const onViewAttachment = vi.fn();
    props.onViewAttachment = onViewAttachment;
    await attach('ready');
    await click(byText('View document'));
    expect(onViewAttachment).toHaveBeenCalledWith('dir/f.pdf');
  });
});

describe('guidance during streaming', () => {
  const streaming = (extra: Record<string, unknown> = {}) => render({ isStreaming: true, canGuideResponse: true, onGuideResponse: vi.fn(async () => {}), messages: [assistant('Working', { isStreaming: true })], ...extra });
  it('sends guidance with quotes and clears input', async () => {
    await streaming();
    expect($('.sr-only[role=status]')?.textContent).toContain('Send guidance to steer');
    expect(textarea().placeholder).toBe('Guide this response…');
    await click(byText('Quote two'));
    await type('Shorter');
    await send();
    expect(props.onGuideResponse.mock.calls[0][0]).toContain('Shorter\n\nSelected text:');
    expect(textarea().value).toBe('');
    expect($('#guidance-status')?.textContent).toBe('Guidance sent to Buddy.');
    expect($('#guidance-status')?.getAttribute('role')).toBe('status');
    expect(textarea().getAttribute('aria-describedby')).toBe('guidance-status');
  });
  it.each([
    [new Error('Rejected'), 'Rejected'],
    ['boom', 'Could not send guidance. Please try again.'],
  ])('reports guidance failure %#', async (error, text) => {
    await streaming({ onGuideResponse: vi.fn(async () => { throw error; }) });
    await type('Shorter');
    await send();
    expect($('#guidance-status')?.textContent).toBe(text);
    expect($('#guidance-status')?.className).toContain('error');
    expect(textarea().value).toBe('Shorter');
  });
  it('shows pending state and avoids double submission', async () => {
    let done = () => {};
    await streaming({ onGuideResponse: vi.fn(() => new Promise<void>(r => { done = r; })) });
    await type('Wait');
    await send();
    expect(byText('Sending…')).toBeTruthy();
    await send();
    expect(props.onGuideResponse).toHaveBeenCalledOnce();
    await act(async () => { done(); await flush(); });
    expect(byText('Send guidance')).toBeTruthy();
  });
  it('keeps input when user edits or session changes during guidance', async () => {
    let done = () => {};
    await streaming({ onGuideResponse: vi.fn(() => new Promise<void>(r => { done = r; })) });
    await type('Wait');
    await send();
    await render({ sessionId: 's9' });
    await act(async () => { done(); await flush(); });
    expect($('#guidance-status')).toBeNull();
    expect(textarea().value).toBe('Wait');
  });
  it('disables composer while streaming without guidance and allows stop', async () => {
    await render({ isStreaming: true });
    expect(textarea().disabled).toBe(true);
    expect(textarea().placeholder).toBe('Waiting for this response…');
    expect($('.sr-only[role=status]')?.textContent).toContain('Use Stop generation');
    await click($('.stop-button')!);
    expect(props.onStop).toHaveBeenCalled();
  });
  it('locks stop during saving', async () => {
    await streaming({ messages: [assistant('x', { isStreaming: true, deliveryState: 'saving' })] });
    expect($<HTMLButtonElement>('.stop-button')!.disabled).toBe(true);
    expect($('.stop-button')?.getAttribute('aria-label')).toBe('Saving files');
    expect($('.sr-only[role=status]')?.textContent).toContain('Saving files');
    expect($('.avatar')?.textContent).toBe('B');
    expect($('.fake-md')?.dataset.streaming).toBe('false');
  });
});

describe('agents mode', () => {
  it('shows agent picker and chips', async () => {
    const onChangeAttachedAgents = vi.fn(), onChangeAgent = vi.fn();
    await render({ talkToAgentsMode: true, onChangeAttachedAgents, onChangeAgent, attachedAgents: ['a1', 'ghost'] });
    expect(has('Boost your Productivity')).toBe(true);
    await click(byText('Attach a1'));
    expect(onChangeAttachedAgents).toHaveBeenCalledWith(['a1']);
    expect(onChangeAgent).toHaveBeenCalledWith('');
    onChangeAgent.mockClear();
    await click(byText('Detach all'));
    expect(onChangeAgent).not.toHaveBeenCalled();
    await click($('[aria-label="Remove agent Agent One"]')!);
    expect(onChangeAttachedAgents).toHaveBeenLastCalledWith(['ghost']);
    expect($('[aria-label="Remove agent ghost"]')).not.toBeNull();
    expect($('select[aria-label="Select skill"]')).toBeNull();
  });
  it('toggles the picker from the tools row after messages', async () => {
    await render({ talkToAgentsMode: true, attachedAgents: ['a1'], messages: [user('Hi')] });
    await click($('.chat-context-chip-add')!);
    expect($('#chat-skill-picker .fake-agents')).not.toBeNull();
    await click($('.composer-tool-shortcut')!);
    expect($('#chat-skill-picker')).toBeNull();
  });
  it('focuses skill search on picker request', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 1; });
    await render({ messages: [user('Hi')] });
    await render({ agentPickerRequest: 1 });
    await render({ agentPickerRequest: 2 });
    raf.mockRestore();
    expect(document.activeElement).toBe($('[aria-label="Skill search"]'));
  });
  it('focuses picker input from Skills when conversation is empty', async () => {
    await render();
    await click($('.composer-tool-shortcut')!);
    expect(document.activeElement).toBe($('[aria-label="Skill search"]'));
  });
  it('renders composer references, tools and shortcuts', async () => {
    await render({ composerReferences: <i>refs</i>, composerTools: <i>tools</i>, composerShortcuts: <i>cuts</i> });
    expect($('.composer-reference-tray')?.textContent).toBe('refs');
    expect($('.composer-context-tools')?.textContent).toBe('tools');
    expect($('.composer-tool-shortcuts')?.textContent).toBe('cuts');
  });
});

describe('user messages', () => {
  it('renders attachments, references and deletion', async () => {
    const onDeleteMessage = vi.fn(async () => {});
    await render({ onDeleteMessage, messages: [user('[Attached spreadsheet: data.xlsx]\nLook at it', { noteReferences: [{ id: 'n', title: 'Note A', truncated: true }, { id: 'n2', title: 'Note B' }], officeReferences: [{ id: 'o', name: 'Doc A', truncated: true }, { id: 'o2', name: 'Doc B' }] })] });
    const texts = $$('.message-attachment-details').map(e => e.textContent);
    expect(texts[0]).toContain('XLSX · Spreadsheet');
    expect(texts[1]).toContain('Partial document context');
    expect(texts[2]).not.toContain('Partial');
    expect(texts[3]).toContain('Office Suite');
    expect($('.message.user p')?.textContent).toBe('Look at it');
    await click($('.message.user button[class*=delete], .message.user button')!);
    expect(onDeleteMessage).toHaveBeenCalledWith('u1');
  });
  it('labels generic attachments and hides quiz submissions', async () => {
    await render({ messages: [user('[Attached file: a.bin]\n'), user('Quiz submission: x', { id: 'q' })] });
    expect($('.message-attachment-details small')?.textContent).toContain('BIN · Attached file');
    expect($$('.message.user')).toHaveLength(1);
  });
});

describe('assistant messages', () => {
  it('renders thinking, generating avatar, guidance and approvals', async () => {
    const approval = { approval_id: 'ap1' };
    await render({ isStreaming: true, messages: [assistant('<think>plan</think>Answer', { isStreaming: true, approvals: [approval], guidance: [{ id: 'g1', text: 'Be short', status: 'applied' }, { id: 'g2', text: 'Be kind', status: 'received' }] })] });
    expect($('.fake-context')?.textContent).toBe('plan');
    expect($('.fake-md')?.textContent).toBe('Answer');
    expect($('.avatar-spark')).not.toBeNull();
    expect($$('.chat-guidance-status').map(s => s.textContent)).toEqual(['Applied', 'Received']);
    await click(byText('Approve ap1'));
    expect(props.onApprovalDecision).toHaveBeenCalledWith(approval, 'approve');
  });
  it('speaks only prose for voice messages and suppresses follow-ups', async () => {
    await render({ messages: [assistant('**Hi** there\n\n```next\nOne\nTwo\n```', { voiceMode: true })] });
    expect($('.fake-md')?.textContent).toBe('Hi there');
    expect($('.fake-clarify')).toBeNull();
  });
  it('shows follow-up form and routes replies to onFollowUp with the original request', async () => {
    const onFollowUp = vi.fn();
    await render({ onFollowUp, messages: [user('Make deck', { presentationFormat: 'pptx', templateId: 't1' }), assistant('Done\n\n```next\n{"options":["One option here","Another option here"]}\n```', { mode: 'chat' })] });
    expect($('.fake-clarify')?.textContent).toContain('What would you like to do next?');
    expect($('.fake-clarify')?.dataset).toMatchObject({ answered: 'false', cancelled: 'false' });
    await click(byText('Reply'));
    expect(onFollowUp).toHaveBeenCalledWith('my reply', 'chat', 'pptx', 't1');
  });
  it('marks forms answered or cancelled from subsequent prompts', async () => {
    const next = '```next\n{"options":["One option here","Another option here"]}\n```';
    await render({ messages: [assistant(next), user('I have cancelled this clarification form because', { id: 'u9' })] });
    expect($('.fake-clarify')?.dataset).toMatchObject({ answered: 'true', cancelled: 'true' });
    await click(byText('Reply'));
    expect(props.onSendMessage).toHaveBeenCalledWith('my reply', undefined, undefined, undefined);
  });
  it('hides next-step forms in read-only and while streaming', async () => {
    const next = '```next\n{"options":["One option here","Another option here"]}\n```';
    await render({ readOnly: true, messages: [assistant(next)] });
    expect($('.fake-clarify')).toBeNull();
    await render({ readOnly: false, messages: [assistant(next, { isStreaming: true })] });
    expect($('.fake-clarify')).toBeNull();
  });
  it('wires quizzes, results and errors', async () => {
    await render({ messages: [assistant('QUIZ1 intro'), assistant('RESULT1 done', { id: 'a2' })] });
    await click(byText('Submit quiz'));
    expect(props.onSendMessage).toHaveBeenCalledWith('Quiz submission: answers', 'agent');
    await click(byText('Practice'));
    expect(props.onSendMessage).toHaveBeenCalledWith('practice', 'agent');
    await click(byText('View results'));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
  it('shows quiz and review load errors only once complete', async () => {
    await render({ messages: [assistant('QUIZERR'), assistant('REVIEWERR', { id: 'a2' })] });
    expect($$('[role=alert]').map(e => e.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('This quiz could not be loaded'), expect.stringContaining('This test review could not be loaded')]));
    await render({ messages: [assistant('QUIZERR', { isStreaming: true })] });
    expect(has('This quiz could not be loaded')).toBe(false);
  });
  it('renders sticky notes when complete and offers Make notes otherwise', async () => {
    await render({ messages: [assistant('Intro text\n\n```bobnotes\n{"notes":[{"title":"T","body":"B","color":"mint"}]}\n```')] });
    expect($('.fake-notes')?.textContent).toBe('1 notes');
    expect($('.fake-md')?.textContent).toBe('Intro text');
    await render({ messages: [assistant(longAnswer)] });
    await click($$('.msg-actions button').find(b => b.textContent?.includes('Make notes'))!);
    expect(props.onSendMessage.mock.calls[0][0]).toContain('Make me sticky notes');
    expect(props.onSendMessage.mock.calls[0][1]).toBe('agent');
  });
  it('wires delete, branch, read aloud, executive deck and usage', async () => {
    const onDeleteMessage = vi.fn(async () => {}), onBranch = vi.fn(async () => {}), onGenerateDeckFromMessage = vi.fn();
    await render({ onDeleteMessage, onBranch, onGenerateDeckFromMessage, messages: [user('Q'), assistant(longAnswer, { tokens: 1500, cost: 2.5 })] });
    const action = (name: string) => [...$$('.msg-actions button')].find(b => b.textContent?.includes(name) || b.querySelector(`[aria-label="${name}"]`) || b.getAttribute('aria-label') === name) as HTMLElement;
    await click(action('Delete answer'));
    expect(onDeleteMessage).toHaveBeenCalledWith('a1');
    await click(action('Branch conversation'));
    expect(onBranch).toHaveBeenCalledWith(0);
    await click(action('Read aloud'));
    expect($('.fake-voice')?.dataset.read).toBe(longAnswer);
    await click(action('Executive Deck'));
    expect(onGenerateDeckFromMessage).toHaveBeenCalledWith(longAnswer);
    expect($('.fake-feedback')?.textContent).toBe('0');
    expect($('.answer-usage')).not.toBeNull();
  });
  it('uses stored history index', async () => {
    const onBranch = vi.fn(async () => {});
    await render({ onBranch, messages: [assistant(longAnswer, { historyTurnIndex: 5 })] });
    expect($('.fake-feedback')?.textContent).toBe('5');
    await click([...$$('.msg-actions button')].find(b => b.textContent?.includes('Branch conversation'))!);
    expect(onBranch).toHaveBeenCalledWith(5);
  });
  it('shows usage with tokens only or cost only, and hides otherwise', async () => {
    await render({ messages: [assistant('x', { tokens: 10 })] });
    expect($('.answer-usage')).not.toBeNull();
    await render({ messages: [assistant('x', { cost: 1 })] });
    expect($('.answer-usage')).not.toBeNull();
    await render({ messages: [assistant('x', { tokens: 0, cost: 0 })] });
    expect($('.answer-usage')).toBeNull();
  });
  it('disables prompting from answers while busy and hides actions in read-only', async () => {
    await render({ readOnly: true, messages: [assistant(longAnswer)] });
    expect($('.fake-md')?.dataset.prompt).toBe('false');
    expect($('.fake-share')).toBeNull();
    await render({ readOnly: false });
    expect($('.fake-md')?.dataset.prompt).toBe('true');
    expect($('.fake-share')).not.toBeNull();
  });
});

describe('presentations in chat', () => {
  const deck = { title: 'D', slides: [{ title: 'One' }] };
  const fence = (value: unknown) => '```bobdeck\n' + JSON.stringify(value) + '\n```';
  const opened = () => { const spy = vi.fn(); window.addEventListener('buddy-open-presentation', spy as EventListener, { once: true }); return spy; };
  it('opens embedded decks in studio and strips source from chat', async () => {
    await render({ messages: [assistant(`Here it is\n\n${fence(deck)}`)] });
    expect($('.message.assistant')?.className).toContain('has-deck-message');
    expect($('.fake-md')?.textContent).toBe('Here it is');
    const spy = opened();
    await click(byText('Open Presentation Studio'));
    expect(spy.mock.calls[0][0].detail).toMatchObject({ sessionId: 's1', deck });
  });
  it('announces the deck when no prose remains', async () => {
    await render({ messages: [assistant(fence(deck))] });
    expect(has('Here is your presentation:')).toBe(true);
  });
  it('hides deck controls once deleted', async () => {
    await render({ messages: [assistant(`Text\n\n${fence(deck)}`, { presentationDeleted: true })] });
    expect(byText('Open Presentation Studio')).toBeUndefined();
    expect($('.message.assistant')?.className).not.toContain('has-deck-message');
  });
  it('loads file decks once and tolerates invalid or failed responses', async () => {
    const ref = '```bobdeck\nout/my.bobdeck\n```';
    deckApi.fetchDeckByPath.mockResolvedValue(deck);
    await render({ messages: [assistant(`See deck\n\n${ref}`)] });
    await flush();
    expect(deckApi.fetchDeckByPath).toHaveBeenCalledWith('out/my.bobdeck', 's1');
    const calls = deckApi.fetchDeckByPath.mock.calls.length;
    await render({ messages: [assistant(`See deck\n\n${ref}`)] });
    expect(deckApi.fetchDeckByPath.mock.calls.length).toBe(calls);
    const spy = opened();
    await click(byText('Open Presentation Studio'));
    expect(spy.mock.calls[0][0].detail).toMatchObject({ path: 'out/my.bobdeck', deck });
    deckApi.fetchDeckByPath.mockRejectedValue(new Error('gone'));
    await render({ sessionId: 's2', messages: [assistant(ref)] });
    await flush();
    expect(has('Here is your presentation:')).toBe(true);
    deckApi.fetchDeckByPath.mockResolvedValue({ slides: 'nope' });
    await render({ sessionId: 's3' });
    await flush();
    expect(byText('Open Presentation Studio')).toBeTruthy();
  });
  it('skips deck loading in read-only, without a session, and while streaming', async () => {
    const ref = '```bobdeck\nout/my.bobdeck\n```';
    await render({ readOnly: true, messages: [assistant(ref)] });
    await render({ readOnly: false, sessionId: undefined });
    await render({ sessionId: 's1', messages: [assistant(ref, { isStreaming: true }), user('next')] });
    await flush();
    expect(deckApi.fetchDeckByPath).not.toHaveBeenCalled();
  });
  it.each([
    [{ isStreaming: true }, 'chat', 'working .bobdeck'],
    [{ isStreaming: true, mode: 'presentation' }, 'chat', 'Hello there'],
    [{ isStreaming: true }, 'presentation', 'Hello there'],
    [{ isStreaming: true }, 'chat', '```bobdeck\n{"slides":['],
  ])('shows generating indicator for %j in %s', async (extra, activeMode, content) => {
    await render({ activeMode, isStreaming: true, messages: [assistant(content, extra)] });
    expect($('.bobdeck-generating-indicator')?.textContent).toContain('Creating your presentation');
    expect(byText('Open Presentation Studio')).toBeTruthy();
  });
  it('uses saved html presentations', async () => {
    await render({ messages: [assistant('Saved', { mode: 'presentation', htmlFilename: 'x.html' })] });
    const spy = opened();
    await click(byText('Open Presentation Studio'));
    expect(spy.mock.calls[0][0].detail.path).toBe('x.html');
    expect($('.message.assistant')?.className).toContain('has-deck-message');
  });
});

describe('scrolling', () => {
  const scroller = () => $('.conversation')!;
  const metrics = (top: number, height = 1000, client = 100) => Object.defineProperties(scroller(), { scrollTop: { configurable: true, writable: true, value: top }, scrollHeight: { configurable: true, value: height }, clientHeight: { configurable: true, value: client } });
  const raf = () => act(async () => { await new Promise(r => requestAnimationFrame(r)); });
  const scrolled = () => act(async () => { scroller().dispatchEvent(new Event('scroll', { bubbles: true })); });
  it('shows jump button when far from bottom, with streaming wording', async () => {
    await render({ messages: [user('Hi')] });
    await raf();
    metrics(100);
    await scrolled();
    expect($('.scroll-bottom-btn')?.textContent).toContain('Latest');
    await click($('.scroll-bottom-btn')!);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
    await render({ isStreaming: true });
    expect($('.scroll-bottom-btn')?.textContent).toContain('New output');
    metrics(900);
    await scrolled();
    expect($('.scroll-bottom-btn')).toBeNull();
  });
  it('follows output until the user scrolls up, then stays', async () => {
    await render({ messages: [user('Hi')] });
    await raf();
    metrics(900);
    await scrolled();
    metrics(0, 2000);
    await render({ messages: [user('Hi'), assistant('More')] });
    await raf();
    expect(scroller().scrollTop).toBe(1900);
    metrics(1000, 2000);
    await scrolled();
    await render({ messages: [user('Hi'), assistant('More more')] });
    await raf();
    expect(scroller().scrollTop).toBe(1000);
  });
  it('stops following on upward wheel, card focus or note flight', async () => {
    await render({ messages: [user('Hi')] });
    await raf();
    metrics(0);
    const wheel = (deltaY: number, target: Element = scroller()) => act(async () => { target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })); });
    await wheel(-10);
    await render({ messages: [user('Hi'), assistant('More')] });
    await raf();
    expect(scroller().scrollTop).toBe(0);
    await wheel(10, $('.chat-context-bar')!);
    expect(scroller().scrollTop).toBe(10);
    await act(async () => { window.dispatchEvent(new Event('buddy-note-flight-scroll')); });
    await render({ messages: [user('Hi'), assistant('Even more')] });
    await raf();
    expect(scroller().scrollTop).toBe(10);
  });
  it('leaves inner scrollable regions alone', async () => {
    await render({ messages: [user('Hi')] });
    await raf();
    metrics(0);
    const inner = document.createElement('pre'); inner.style.overflowY = 'auto';
    Object.defineProperties(inner, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    $('.chat-context-bar')!.append(inner);
    await act(async () => { inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true })); });
    expect(scroller().scrollTop).toBe(0);
    Object.defineProperties(textarea(), { scrollHeight: { configurable: true, value: 300 }, clientHeight: { configurable: true, value: 50 } });
    await act(async () => { textarea().dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true })); });
    expect(scroller().scrollTop).toBe(0);
    inner.remove();
  });
  it('keeps completed quizzes in view instead of following', async () => {
    await render({ messages: [assistant('QUIZ1 stream', { isStreaming: true })] });
    await raf();
    metrics(0);
    await render({ messages: [assistant('QUIZ1 stream')] });
    await raf();
    expect(scroller().scrollTop).toBe(0);
  });
  it('follows height changes through ResizeObserver', async () => {
    await render({ messages: [user('Hi')] });
    await raf();
    metrics(0);
    await raf();
    await act(async () => { FakeResize.list.at(-1)!.cb(); await new Promise(r => requestAnimationFrame(r)); });
    expect(scroller().scrollTop).toBe(900);
  });
  it('card interaction pauses following', async () => {
    await render({ messages: [user('Hi'), assistant('```next\n{"options":["One option here","Another option here"]}\n```')] });
    await raf();
    metrics(0);
    const card = document.createElement('div'); card.className = 'quiz-card'; $('.conversation-content')!.append(card);
    await act(async () => { card.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    await render({ messages: [user('Hi'), assistant('more')] });
    await raf();
    expect(scroller().scrollTop).toBe(0);
    card.remove();
  });
  it('scrolls to the bottom shortly after sending', async () => {
    await render({ messages: [user('Hi')] });
    await raf();
    metrics(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await type('Next');
    await send();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(scroller().scrollTop).toBe(1000);
  });
});
