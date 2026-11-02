import { expect, test } from 'vitest';
import { marked } from 'marked';
import * as clarification from '../../src/lib/clarification';
import * as quiz from '../../src/lib/quiz';
import * as fixedRouting from '../../src/lib/fixedDiagramRouting';
import * as diagramLayout from '../../src/lib/diagramLayout';
import { streamMarkdown } from '../../src/lib/streamMarkdown';
import { runClarificationChecks } from '../../../tests/contracts/clarification.mjs';
import { runQuizChecks } from '../../../tests/contracts/quiz.mjs';
import { runFixedRoutingChecks } from '../../../tests/contracts/fixedDiagramRouting.mjs';
import { runDiagramLayoutChecks } from '../../../tests/contracts/diagramLayout.mjs';
import { runStreamMarkdownChecks } from '../../../tests/contracts/streamMarkdown.mjs';

test('clarification forms preserve prose and hide every incomplete streaming prefix', () => {
  expect(() => runClarificationChecks(clarification)).not.toThrow();
});
test('quiz parsing conceals answer keys, validates metadata and rejects unsafe resources', () => {
  expect(() => runQuizChecks(quiz)).not.toThrow();
});
test('streamed citations hide partial URLs and supporting quotes without hiding prose', () => {
  expect(() => runStreamMarkdownChecks({ streamMarkdown, marked })).not.toThrow();
});
test('fixed diagram routes preserve supplied coordinates and avoid node intersections', () => {
  expect(() => runFixedRoutingChecks(fixedRouting)).not.toThrow();
});
test('real ELK layouts retain nodes, edges, viewport bounds and explained fallbacks', async () => {
  await expect(runDiagramLayoutChecks(diagramLayout)).resolves.toBeUndefined();
}, 30000);

test('fallback suggestions never extract data from quoted or incomplete code examples', () => {
  const data = '{"options":["Fixture A","Fixture B"]}';
  for (const code of [
    '```text\n' + data + '\n```',
    '````text\n```json\n' + data + '\n```\n````',
    '~~~python\n' + data + '\n~~~',
    '```text\n' + data,
  ]) {
    expect(clarification.parseNextQuestions(code)).toEqual({ text: code, options: [] });
  }
  expect(clarification.parseNextQuestions('```json\n' + data + '\n```').options).toEqual(['Fixture A', 'Fixture B']);
  const example = '```text\n{"example":"literal"}\n```';
  expect(clarification.parseNextQuestions(example + '\n' + data))
    .toEqual({ text: example, options: ['Fixture A', 'Fixture B'] });
});

test('long malformed closing markers remain inert code examples', () => {
  const code = '```text\n' + '`'.repeat(100000) + 'not-a-closing-fence\n{"options":["A","B"]}\n```';
  expect(clarification.parseNextQuestions(code)).toEqual({ text: code, options: [] });
});
