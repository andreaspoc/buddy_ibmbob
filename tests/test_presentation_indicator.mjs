import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
let ts;
try { ts = require('typescript'); } catch {
  const babel = require('@babel/core');
  ts = { ModuleKind: { ESNext: 'esnext' }, transpileModule: source => ({ outputText: babel.transformSync(source, { filename: 'fixture.ts', plugins: ['@babel/plugin-transform-typescript'] }).code }) };
}

// Load extractDeck and ChatView logic
const classifierSource = readFileSync(new URL('../web/src/lib/presentationFiles.ts', import.meta.url), 'utf8');
const extractDeckSource = classifierSource + '\n' + readFileSync(new URL('../web/src/lib/extractDeck.ts', import.meta.url), 'utf8').replace(/^import[^\n]+presentationFiles[^\n]+\n/m, '');
const compiledExtract = ts.transpileModule(extractDeckSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { extractLiveBobdeck, extractBobdeck, extractHtmlDeck } = await import(`data:text/javascript;base64,${Buffer.from(compiledExtract).toString('base64')}`);

function computeIsGeneratingDeck({ msg, activeMode }) {
  const textWithoutThink = msg.content;
  const bobdeckData = msg.presentationDeleted ? null : extractBobdeck(textWithoutThink);
  const htmlDeckData = msg.presentationDeleted ? null : extractHtmlDeck(textWithoutThink, Boolean(msg.isStreaming));
  const resolvedDeck = msg.presentationDeleted ? null : (msg.deckJson || (bobdeckData?.deck ?? null));

  return msg.isStreaming && Boolean(
    activeMode === 'presentation' ||
    msg.mode === 'presentation' ||
    /```(?:bobdeck)/i.test(msg.content) ||
    msg.content.toLowerCase().includes('.bobdeck') ||
    extractLiveBobdeck(textWithoutThink) ||
    resolvedDeck ||
    htmlDeckData
  );
}

// 1. Conversational response mentioning presentations / slides should NOT trigger presentation generator
const conversationalMsg = {
  isStreaming: true,
  mode: 'agent',
  content: `No, I'm not able to generate images. As Buddy, powered by IBM Bob, my capabilities are focused on:

📄 Documents — creating, editing, and analysing Word, Excel, and PowerPoint files
📊 Data & Charts — analysing datasets and producing interactive charts directly in chat
🔍 Research — searching the web and IBM documentation for up-to-date information
📑 Reports & Presentations — building slide decks and business reports
💬 Business Operations — supporting workflows, planning, and general workplace tasks
🖥️ Engineering — assisting with Company A-specific operations and queries
🤖 Automation — scripting, data processing, and task automation
If you need an image created, you'd need a dedicated image generation tool. However, if you need charts, diagrams, or data visualisations, I can absolutely produce those for you directly in chat! Just let me know what you need. 😊`,
};

assert.equal(
  computeIsGeneratingDeck({ msg: conversationalMsg, activeMode: 'agent' }),
  false,
  'Conversational mentions of presentations/slides in agent mode must NOT trigger presentation generation widget'
);

// 2. Casual question answering mentioning presentations
const casualQuestionMsg = {
  isStreaming: true,
  mode: 'chat',
  content: 'I can help you review the slide notes and presentation outline you shared earlier.',
};

assert.equal(
  computeIsGeneratingDeck({ msg: casualQuestionMsg, activeMode: 'chat' }),
  false,
  'Casual chat mentioning presentation outline must NOT trigger presentation generation widget'
);

// 3. When activeMode is presentation, it SHOULD trigger
assert.equal(
  computeIsGeneratingDeck({ msg: { isStreaming: true, mode: 'presentation', content: 'Starting...' }, activeMode: 'presentation' }),
  true,
  'Presentation mode must trigger isGeneratingDeck'
);

// 4. When msg.mode is presentation, it SHOULD trigger
assert.equal(
  computeIsGeneratingDeck({ msg: { isStreaming: true, mode: 'presentation', content: 'Starting...' }, activeMode: 'agent' }),
  true,
  'msg.mode = presentation must trigger isGeneratingDeck'
);

// 5. When streaming real bobdeck slides, it SHOULD trigger
const liveSlideMsg = {
  isStreaming: true,
  mode: 'agent',
  content: '{"slides":[{"id":"s1","title":"Executive Summary"}]}',
};
assert.equal(
  computeIsGeneratingDeck({ msg: liveSlideMsg, activeMode: 'agent' }),
  true,
  'Live slides array must trigger isGeneratingDeck'
);

// 6. When generating ```bobdeck code fence, it SHOULD trigger
const bobdeckFenceMsg = {
  isStreaming: true,
  mode: 'agent',
  content: '```bobdeck\n{"slides":[]}\n```',
};
assert.equal(
  computeIsGeneratingDeck({ msg: bobdeckFenceMsg, activeMode: 'agent' }),
  true,
  'Bobdeck code fence must trigger isGeneratingDeck'
);

console.log('All presentation indicator exclusion checks passed!');

assert.equal(extractHtmlDeck('Created [report](presentation.html)'), null, 'Names cannot turn reports into presentations');
assert.equal(extractHtmlDeck('```html\n<!DOCTYPE html><html><body><canvas></canvas><script>new Chart()</script></body></html>\n```'), null, 'Charts alone are report content');
assert.ok(extractHtmlDeck('```html\n<html><body><section class="slide">One</section><section class="slide">Two</section></body></html>\n```'), 'Actual slide markup opens Presentation Studio');
console.log('HTML report/presentation classification checks passed!');
