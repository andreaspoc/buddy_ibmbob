import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpile } from './frontend_transpile.mjs';
const exports = {};
new Function('exports', transpile(readFileSync(new URL('../web/src/lib/diagramSizing.ts', import.meta.url), 'utf8'), true))(exports);
const { diagramWidthFit: fit } = exports;
for (const availableWidth of [280, 390, 600, 1000]) {
  const vertical = fit(244, 2600, availableWidth);
  assert.ok(vertical.zoom >= 0.98, 'A single vertical column retains readable text');
  assert.ok(vertical.height >= 2500, 'The whole answer grows beyond the old fixed canvas');
  for (const [width, height] of [[700, 500], [1200, 2400], [244, 2600]]) {
    const viewport = fit(width, height, availableWidth);
    assert.ok(viewport.x + width * viewport.zoom <= availableWidth - 19.9, 'Right side fits card width');
    assert.ok(viewport.y + height * viewport.zoom <= viewport.height - 19.9, 'Last node is within natural-height card');
    assert.ok(viewport.zoom <= 1, 'Small diagrams are not enlarged');
  }
}
assert.equal(fit(700, 2000, 600).zoom, fit(700, 200, 600).zoom, 'Height never shrinks the diagram');
assert.ok(fit(700, 2000, 600).height > fit(700, 200, 600).height);
const source = readFileSync(new URL('../web/src/components/StructuredDiagram.tsx', import.meta.url), 'utf8');
assert.ok(source.includes('layoutDiagram(spec, availableWidth, 500, { pairedRows: compact })'), 'Layout input is independent of output canvas height');
assert.ok(source.includes('const readingView = maximized &&'), 'Inline answers do not require an inner scrolling view');
console.log('PASS diagram width fitting, uncapped natural height, readable vertical columns and responsive bounds');

assert.ok(source.includes('zoomOnScroll={maximized && !readingView}'));
assert.ok(source.includes('zoomOnPinch={maximized && !readingView}'));
assert.ok(source.includes('preventScrolling={maximized && !readingView}'));
assert.ok(source.includes('panOnDrag={maximized && !readingView}'));
const css = readFileSync(new URL('../web/src/components/StructuredDiagram.css', import.meta.url), 'utf8');
assert.ok(css.includes('.structured-diagram:not(.structured-diagram-maximized) .react-flow__pane { touch-action:pan-y; }'));
console.log('PASS inline wheel and touch scroll reach chat while maximized navigation stays interactive');
assert.ok(source.includes('onZoomIn={() => { userNavigated.current = true; }}'));
assert.ok(source.includes('onZoomOut={() => { userNavigated.current = true; }}'));
assert.ok(source.includes('nodesDraggable={maximized}'));
for (const width of [280, 600, 1000, 1440]) {
 for (const contentWidth of [244, 624, 924]) {
  const viewport = fit(contentWidth, 600, width, 20, true);
  assert.ok(Math.abs(viewport.x + contentWidth * viewport.zoom / 2 - width / 2) < 0.01, 'Compact inline diagram centers inside the available card');
 }
}
console.log('PASS: compact inline diagrams are centered rather than anchored in a corner');
