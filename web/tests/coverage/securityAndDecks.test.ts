import { describe, expect, test } from 'vitest';
import { redactActivity } from '../../src/lib/redaction';
import { extractBobdeck, extractLiveBobdeck, extractHtmlDeck } from '../../src/lib/extractDeck';
import { isPresentationFile, isPresentationHtml } from '../../src/lib/presentationFiles';

describe('credential masking', () => {
  test('masks nested sensitive values and embedded credentials', () => {
    expect(redactActivity({ password: 'fixture', work: ['api_key=fixture', 'Bearer fixture', 'https://u:p@example.test/path'] }))
      .toEqual({ password: '[redacted]', work: ['api_key=[redacted]', 'Bearer [redacted]', 'https://[redacted]@example.test/path'] });
    expect(redactActivity('eyJabc.def.ghi')).toBe('[redacted]');
  });
  test('preserves noncredentials, empty values and incomplete URLs', () => {
    for (const value of ['ordinary=fixture', 'token fixture', 'token=""', 'https://user@example.test', 'https://u:@example.test']) {
      expect(redactActivity(value)).toBe(value);
    }
    expect(redactActivity(null)).toBeNull();
    expect(redactActivity(42)).toBe(42);
    expect(redactActivity('token = "fixture"&next=ok')).toBe('token = "[redacted]"&next=ok');
  });
});

describe('presentation extraction', () => {
  test('extracts complete fenced and loose decks while retaining prose', () => {
    expect(extractBobdeck('before ```json\n{"slides":[]}\n``` after'))
      .toMatchObject({ deck: { slides: [] }, cleanText: 'before  after', isPartial: false });
    expect(extractBobdeck('before {"slides":[]} after')).toMatchObject({ deck: { slides: [] }, cleanText: 'before  after' });
    expect(extractBobdeck('```bobdeck\nfixture.bobdeck\n```')).toMatchObject({ filename: 'fixture.bobdeck' });
    expect(extractBobdeck('Open /Deck.BOBDECK')).toMatchObject({ filename: 'Deck.BOBDECK' });
  });
  test('rejects malformed or unrelated payloads and incomplete fences', () => {
    for (const input of ['', 'ordinary', '{"slides":null}', '```json\n{broken}\n```', '```bobdeck\n\n', '{'.repeat(5000)]) {
      expect(extractBobdeck(input)).toBeNull();
    }
  });
  test('emits only completed slides from a partial response', () => {
    expect(extractLiveBobdeck('{"slides":[{"id":"fixture","title":"Fixture"},{"title":'))
      .toMatchObject({ deck: { slides: [{ id: 'fixture', title: 'Fixture' }] }, isPartial: true });
    expect(extractLiveBobdeck('{"slides":[]}')).toMatchObject({ isPartial: false });
    expect(extractLiveBobdeck('plain')).toBeNull();
  });
  test('recognizes explicit presentation metadata and slide markup', () => {
    expect(isPresentationFile({ name: 'Deck.BOBDECK' })).toBe(true);
    expect(isPresentationFile({ is_presentation: false, name: 'Deck.bobdeck' })).toBe(false);
    expect(isPresentationFile({ kind: 'presentation' })).toBe(true);
    expect(isPresentationHtml('<section class="slide">Fixture</section>')).toBe(true);
    expect(isPresentationHtml('<meta name="bob-artifact-role" content="presentation">')).toBe(true);
    expect(isPresentationHtml('<main>Report</main>')).toBe(false);
    expect(isPresentationFile({})).toBe(false);
    const html = '<html><body><section class="slide">Fixture</section></body></html>';
    expect(extractHtmlDeck('```html\n' + html + '\n```')).toMatchObject({ html });
  });
});
