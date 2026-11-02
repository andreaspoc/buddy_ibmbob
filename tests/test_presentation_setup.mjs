import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpile } from './frontend_transpile.mjs';

const source = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleSendMessage = async');
const end = source.indexOf('    // Add user message', start);
const routing = transpile(source.slice(start, end) + '\nreturn { targetMode, targetAgent, targetSkill, presentationFormat, templateId, effectiveSlideCount };\n};');
const catalog = [{ id: 'custom-catalog-theme', title: 'New custom template' }];
async function route(prompt, options = {}) {
  const state = { intentCalls: 0 };
  const session = { current: 'session' };
  const env = {
    window: {}, isStreaming: false, preparingPresentationRef: { current: false },
    selectedProjectRef: { current: '' },
    projectSelectionVersion: { current: 0 },
    selectedSessionRef: session, selectedMode: 'agent', selectedAgent: options.agent || '',
    skills: [{ name: 'research-buddy' }, { name: 'presentation-buddy' }],
    buddySkillName: name => name, slideCount: options.count || 5,
    setSelectedMode: mode => state.mode = mode, setSelectedAgent: () => {},
    setSlideCount: count => state.count = count, setTemplates: templates => state.templates = templates,
    setPendingPresentation: pending => state.pending = pending,
    setSelectedTemplateId: id => state.selected = id,
    setIsTemplateModalOpen: open => state.setup = open,
    setTemplateStudioOpen: open => state.templateStudio = open,
    setIsPreparingPresentation: () => {}, setFeaturePanel: () => {},
    setIsPresentationPanelOpen: open => state.studio = open,
    appAlert: message => state.error = message,
    api: { presentationIntent: async () => {
      state.intentCalls++;
      if (options.fail) throw new Error('Unavailable');
      if (options.switchSession) session.current = 'other-session';
      return options.intent || { presentation: true, format: 'html', slide_count: 12, templates: catalog };
    } },
  };
  const handler = new Function(...Object.keys(env), routing + ';return handleSendMessage;')(...Object.values(env));
  state.result = await handler(prompt, options.mode, options.format, options.template, options.skill, options.editPath, false, options.templateStudio || false);
  return state;
}

for (const prompt of ['Create a Company A navy presentation', 'Could you put this into slides?', '/research-buddy Create slides about our project']) {
  const state = await route(prompt);
  assert.equal(state.setup, true);
  assert.deepEqual(state.templates, catalog);
  assert.equal(state.selected, '', 'No theme may be silently selected from words in the prompt');
  assert.equal(state.count, 12);
  assert.equal(state.result, undefined, 'No task starts before setup confirmation');
}
const unknownFormat = await route('Create a presentation', { intent: { presentation: true, format: null, slide_count: null, templates: catalog } });
assert.equal(unknownFormat.setup, true);
assert.equal(unknownFormat.pending.format, undefined);
const confirmed = await route('Create a presentation', { mode: 'presentation', format: 'html', template: catalog[0].id, count: 7 });
assert.equal(confirmed.result.targetMode, 'presentation');
assert.equal(confirmed.result.templateId, catalog[0].id);
assert.equal(confirmed.result.effectiveSlideCount, 7, 'Confirmed slide count must beat a suggested count');
assert.equal(confirmed.studio, true);
assert.equal((await route('Create a presentation', { format: 'html', template: 'deleted-theme' })).setup, true);
const report = await route('Create an HTML report', { intent: { presentation: false, format: null, slide_count: null, templates: [] } });
assert.equal(report.setup, undefined);
assert.equal(report.result.targetMode, 'agent');
const edit = await route('Make slide 3 simpler', { editPath: 'saved-deck.html' });
assert.equal(edit.intentCalls, 0);
assert.equal(edit.setup, undefined);
assert.equal(edit.result.targetMode, 'agent');
assert.equal((await route('Create a presentation', { switchSession: true })).setup, undefined);
assert.equal((await route('Create a presentation', { fail: true })).error, 'Unavailable');
const researched = await route('/research-buddy Create slides', { mode: 'presentation', format: 'html', template: catalog[0].id });
assert.equal(researched.result.targetSkill, 'research-buddy');
console.log('Presentation setup checks passed: catalog selection, combined setup, explicit count, report separation, saved edits, failures, session isolation.');

const studio = await route('Create a reusable presentation template', {templateStudio: true});
assert.equal(studio.intentCalls, 0);
assert.equal(studio.result.targetMode, 'agent');
assert.equal(studio.result.targetAgent, '');
