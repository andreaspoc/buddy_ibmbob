import { expect, test } from 'vitest';
import { speechText } from '../../src/lib/voice';
import { noteHeadings } from '../../src/lib/noteWriting';
import { buddySkillName } from '../../src/lib/skillNames';
import { parseClarifications } from '../../src/lib/clarification';
import { parseIntelligentSpec } from '../../src/lib/intelligentUi';
import { presentationChatText } from '../../src/lib/presentationChatText';

test('malformed long delimiters remain usable while speech formatting is preserved', () => {
  expect(speechText('# Heading\nA [link](https://example.test)\n| one | two |')).toBe('Heading A link');
  expect(speechText('<'.repeat(30000))).toHaveLength(30000);
  expect(speechText('['.repeat(30000))).toHaveLength(30000);
});

test('note headings and bounded skill names preserve normal behavior', () => {
  expect(noteHeadings('# Heading ###\n```\n# Hidden\n```\n## Next')).toMatchObject([{text: 'Heading', level: 1}, {text: 'Next', level: 2}]);
  expect(noteHeadings('# ' + '#'.repeat(20000) + 'x')).toHaveLength(1);
  expect(buddySkillName('example-agent')).toBe('example-buddy');
  expect(buddySkillName('x'.repeat(57) + '---')).toBe('x'.repeat(57) + '-buddy');
});

test('interactive JSON comments do not alter strings or URLs', () => {
  const input = '{"kind":"explore", /* explanatory comment */ "title":"Example", "items":[{"title":"Site","body":"https://example.test/path"}]}';
  const spec = parseIntelligentSpec(input);
  expect(spec?.kind).toBe('explore');
  if (spec?.kind === 'explore') expect(spec.items[0].body).toBe('https://example.test/path');
  expect(parseIntelligentSpec('{"kind":"explore","title":"' + '/*a'.repeat(20000) + '"}')).toBeDefined();
});

test('malformed closing fences and presentation source do not leak or block prose', () => {
  const input = '```bobquestion\n' + '`'.repeat(30000) + '\r\n';
  expect(parseClarifications(input, true).questions).toEqual([]);
  expect(presentationChatText('Hello\n```bobdeck\n{"slides":[]}\n```\nAfter', true)).toBe('Hello\n\nAfter');
});
