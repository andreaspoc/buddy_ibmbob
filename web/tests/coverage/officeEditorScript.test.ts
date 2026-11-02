import { describe, expect, test } from 'vitest';
import { officeEditorScriptUrl } from '../../src/lib/officeEditorScript';

describe('Office editor script URL', () => {
  test('accepts the configured same-origin proxy and HTTPS editor', () => {
    expect(officeEditorScriptUrl('/office-editor/web-apps/apps/api/documents/api.js', 'http://localhost:8080'))
      .toBe('http://localhost:8080/office-editor/web-apps/apps/api/documents/api.js');
    expect(officeEditorScriptUrl('https://office.example/web-apps/apps/api/documents/api.js', 'https://app.example'))
      .toBe('https://office.example/web-apps/apps/api/documents/api.js');
  });
  test('rejects executable schemes, external HTTP, credentials and unexpected paths', () => {
    for (const url of ['javascript:alert(1)', 'data:text/javascript,alert(1)',
      'http://evil.example/web-apps/apps/api/documents/api.js',
      'https://u:p@office.example/web-apps/apps/api/documents/api.js',
      'https://office.example/payload.js', 'https://office.example/web-apps/apps/api/documents/api.js?x=1']) {
      expect(() => officeEditorScriptUrl(url, 'https://app.example')).toThrow();
    }
  });
});
