import { describe, expect, test } from 'vitest';
import { knowledgeDocumentHref, safeHref } from '../../src/lib/safeHref';

describe('safe links', () => {
  test('allows HTTP URLs and ordinary relative paths', () => {
    expect(safeHref('https://example.test/a')).toBe('https://example.test/a');
    expect(safeHref('/knowledge/example/file')).toBe('/knowledge/example/file');
    expect(safeHref('../report')).toBe('../report');
  });
  test('rejects executable schemes and ambiguous or credentialed URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'vbscript:alert(1)',
      '//evil.example/a', '/\\evil.example/a', 'https://user:pass@example.test/', '/safe\npath']) {
      expect(safeHref(url)).toBeUndefined();
    }
  });
  test('uses only document UUIDs in knowledge links', () => {
    expect(knowledgeDocumentHref('11111111-2222-3333-4444-555555555555', 'file'))
      .toBe('/knowledge/11111111-2222-3333-4444-555555555555/file');
    for (const id of ['../admin', 'javascript:alert(1)', 'x?next=//evil.example']) {
      expect(knowledgeDocumentHref(id, 'file')).toBeUndefined();
    }
  });
});
