/** Synthetic browser fixtures; no live learning records are read or written. */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const base = process.env.LEARNING_UI_URL || 'http://127.0.0.1:3045';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
let creator = true;
let lesson = null;
let status = 'draft';
let progress = null;
const proposal = { title: 'Buddy proposal', description: 'Fixture introduction', steps: [
  { id: 'read', kind: 'text', title: 'Read', text: 'Human-provided source explanation', options: [], answer: null, feedback: '', url: '', asset_id: null },
  { id: 'check', kind: 'question', title: 'Practice', text: 'Choose B', options: ['A', 'B'], answer: 1, feedback: 'B fits the source.', url: '', asset_id: null },
] };
await page.route('**/api/learning/**', async route => {
  const path = new URL(route.request().url()).pathname.replace('/api/learning', '');
  const method = route.request().method();
  let data = {};
  if (path === '/me') data = { username: 'fixture-user', display_name: 'Fixture Author', is_admin: false, can_create_quizzes: creator };
  else if (path === '/folders') data = { items: [{ id: 'folder', name: 'Fixture training' }] };
  else if (path === '/folders/folder/contents') data = { books: [], quizzes: [] };
  else if (path === '/folders/folder/lessons' && method === 'GET') data = { items: lesson ? [{ id: 'lesson', title: lesson.title, status, version: status === 'draft' ? 0 : 1, is_creator: creator }] : [] };
  else if (path === '/folders/folder/lessons' && method === 'POST') { lesson = route.request().postDataJSON(); data = { id: 'lesson' }; }
  else if (path === '/folders/folder/lesson-import') data = { title: 'Imported material', description: '', steps: [proposal.steps[0]] };
  else if (path === '/folders/folder/lesson-draft') data = { draft: proposal, source_truncated: false };
  else if (path === '/lessons/lesson/publish') { status = 'published'; data = { published: true }; }
  else if (path === '/lessons/lesson/check') data = { correct: route.request().postDataJSON().answer === 1, feedback: 'B fits the source.' };
  else if (path === '/lessons/lesson/progress') { progress = route.request().postDataJSON(); data = { saved: true }; }
  else if (path === '/lessons/lesson') data = { ...lesson, id: 'lesson', status, version: 1, is_creator: creator, progress, steps: creator ? lesson.steps : lesson.steps.map(({ answer, feedback, teacher_notes, ...rest }) => rest) };
  await route.fulfill({ json: data });
});
try {
  await page.goto(`${base}/learning/folders/folder?tab=lessons`);
  await page.getByRole('heading', { name: 'Interactive lessons' }).waitFor();
  await page.getByLabel('Signed in as Fixture Author').waitFor();
  await page.getByRole('button', { name: '+ Create lesson' }).click();
  await page.getByRole('button', { name: 'Preview lesson', exact: true }).click();
  await page.getByRole('heading', { name: 'Untitled lesson', exact: true }).waitFor();
  if (lesson || progress) throw new Error('Author preview persisted an unsaved draft or progress');
  await page.getByRole('button', { name: 'Back to editor', exact: true }).click();
  await page.getByLabel('Import document', { exact: true }).setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Human content') });
  await page.getByText('Material imported', { exact: false }).waitFor();
  await page.getByLabel('Instructions for Buddy').fill('Add practice activities from my imported material');
  await page.getByRole('button', { name: 'Draft with Buddy', exact: true }).click();
  await page.getByRole('button', { name: 'Apply Buddy proposal' }).click();
  await page.getByText('Private teacher notes', { exact: true }).first().click();
  await page.getByLabel('Teaching guidance, discussion prompts, or timing').first().fill('Private classroom discussion guidance');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export editable lesson' }).click();
  const exported = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  if (exported.steps[0].teacher_notes !== 'Private classroom discussion guidance') throw new Error('Manual teacher notes lost in editable export');
  await page.getByRole('button', { name: 'Save draft', exact: true }).first().click();
  await page.getByText('Draft saved.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Back to lessons' }).click();
  await page.getByRole('button', { name: 'Approve & publish', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve & publish', exact: true }).click();
  await page.getByText('published · Version 1').waitFor();
  await page.getByRole('button', { name: 'Copy as new lesson' }).click();
  await page.getByLabel('Lesson title', { exact: true }).fill('Independent manual copy');
  await page.getByRole('button', { name: 'Back to lessons' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  if (lesson.title !== 'Buddy proposal') throw new Error('Unsaved lesson copy changed the published original');
  creator = false;
  await page.reload();
  await page.getByRole('button', { name: 'Open lesson' }).click();
  await page.getByRole('button', { name: 'Save & continue' }).click();
  await page.getByRole('navigation', { name: 'Lesson sections', exact: true }).waitFor();
  if (!await page.getByRole('button', { name: 'Complete lesson', exact: true }).isDisabled()) throw new Error('Practice continued before checking');
  await page.getByRole('radio', { name: 'B', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByText('B fits the source.', {exact:true}).waitFor();
  await page.getByRole('button', { name: 'Complete lesson' }).click();
  await page.getByText('Lesson completed.', { exact: false }).waitFor();
  await page.getByRole('region', { name: 'Lesson completion', exact: true }).waitFor();
  if (!progress?.completed || progress.step !== 1) throw new Error('Completion not persisted');
  await page.getByRole('button', { name: 'Back to lessons' }).click();
  await page.getByRole('button', { name: 'Open lesson' }).click();
  await page.getByRole('heading', { name: 'Practice', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Signed in as Fixture Author').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error('Mobile document overflows');
  await page.screenshot({ path: '/tmp/learning-lessons-mobile.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: private teacher notes, editable export, independent copying, human import, Buddy proposal review, draft save/publication, learner feedback, completion/resume, user identity, mobile layout');
} finally { await browser.close(); }
