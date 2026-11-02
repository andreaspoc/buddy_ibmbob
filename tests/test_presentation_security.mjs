import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const viewer = readFileSync(new URL('../web/src/components/HtmlDeckViewer.tsx', import.meta.url), 'utf8');
const security = readFileSync(new URL('../web/src/lib/presentationSecurity.ts', import.meta.url), 'utf8');
// Guard the trust boundary at every insertion path, including streamed document patches.
assert.match(viewer, /srcDoc=\{sanitizeEditablePresentation\(withPresentationTypography\(frameHtml \|\| currentHtml\)\)\}/);
assert.equal((viewer.match(/syncPresentationDocument\(doc,/g) || []).length, 2);
assert.equal((viewer.match(/syncPresentationDocument\(doc, sanitizeEditablePresentation\(withPresentationTypography\(currentHtml\)\)\)/g) || []).length, 2);
assert.match(security, /EDITABLE_PRESENTATION_SANDBOX = 'allow-same-origin'/);
assert.match(security, /LIVE_PRESENTATION_SANDBOX = 'allow-scripts'/);
assert.doesNotMatch(viewer, /allow-scripts allow-same-origin/);
assert.match(viewer, /sandbox=\{EDITABLE_PRESENTATION_SANDBOX\}/);
assert.match(viewer, /sandbox=\{LIVE_PRESENTATION_SANDBOX\}/);
for (const tag of ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'form']) {
  assert.ok(security.includes(`'${tag}'`));
}
assert.match(security, /DOMPurify\.sanitize/);
assert.match(security, /'srcdoc'/);
assert.match(security, /script-src 'none'/);
assert.match(security, /frame-src 'none'/);
assert.match(viewer, /return withPresentationTypography\(restorePresentationSource\(/, 'Saving must preserve live presentation scripts without running them in the editor');
assert.match(security, /source\.querySelectorAll\('\[data-bob-preserved-script\]/, 'Input cannot forge internal preservation markers');
console.log('Presentation frame isolation, sanitized streaming updates, and source-preservation boundaries passed.');
const { transpile } = await import('./frontend_transpile.mjs');
const runtime = transpile(security.replace("import DOMPurify from 'dompurify';", ''));
const { validPresentationSnapshot, sandboxedPresentationPage } = await import(`data:text/javascript;base64,${Buffer.from(runtime).toString('base64')}`);
const page = sandboxedPresentationPage('blob:https://example.test/id" onload="alert(1)');
assert.match(page, /sandbox="allow-scripts"/);
assert.ok(page.includes('id&quot; onload=&quot;alert(1)'));
assert.doesNotMatch(page, /sandbox="allow-scripts allow-same-origin"/);
assert.match(viewer, /sandboxedPresentationPage\(url\)/);
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=', 'base64');
const png = 'data:image/png;base64,' + bytes.toString('base64');
assert.ok(validPresentationSnapshot({index: 0, png}));
for (const value of [null, {}, {index: -1, png}, {index: 20, png}, {index: 0.5, png}, {index: 0, png, html: '<script>'}, {index: 0, png: 'https://example.com/image.png'}, {index: 0, png: 'data:image/svg+xml;base64,PHN2Zz4='}, {index: 0, png: png + 'A'.repeat(1_000_000)}]) {
  assert.equal(validPresentationSnapshot(value), false);
}
const huge = Buffer.from(bytes); huge.writeUInt32BE(100000, 16);
assert.equal(validPresentationSnapshot({index: 0, png: 'data:image/png;base64,' + huge.toString('base64')}), false);
const noHeight = Buffer.from(bytes); noHeight.writeUInt32BE(0, 20);
assert.equal(validPresentationSnapshot({index: 0, png: 'data:image/png;base64,' + noHeight.toString('base64')}), false);
assert.match(viewer, /event\.source !== liveIframeRef\.current\?\.contentWindow/);
assert.match(viewer, /images.length > 20/);
assert.match(viewer, /total > 4_000_000/);
assert.match(viewer, /display: livePreview && !restrictedScripts/);
console.log('Raster bridge rejects foreign types, URLs, excess entries/bytes, forged schema, and oversized PNG dimensions.');
