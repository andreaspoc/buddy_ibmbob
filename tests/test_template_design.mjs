import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from '../web/node_modules/typescript/lib/typescript.js';
const source = readFileSync(new URL('../web/src/lib/templateDesign.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { defaultTemplateDesign, createTemplatePreviewDeck, createTemplateHtml, templateDesignError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const design = structuredClone(defaultTemplateDesign);
design.colors.primary = '#123456';
design.design.shape = 'ellipse';
design.design.decoration = 'topbar';
design.fonts.heading = 'Georgia';
const deck = createTemplatePreviewDeck(design);
assert.equal(deck.slides.length, 3);
assert.equal(deck.theme.colors.primary, '#123456');
assert.ok(deck.slides.every(slide => slide.elements.some(e => e.shape === 'rectangle' && e.y === 0 && e.fill === '#123456')));
assert.ok(deck.slides.every(slide => slide.elements.some(e => e.shape === 'ellipse')));
assert.ok(deck.slides.every(slide => slide.elements.some(e => e.type === 'text' && e.bold && e.style.fontFamily === 'Georgia')));
assert.equal(templateDesignError(design), '');
assert.ok(templateDesignError({ ...design, title: ' ' }));
assert.ok(templateDesignError({ ...design, colors: { ...design.colors, primary: '#badhex' } }));
const html = createTemplateHtml({ ...design, title: '</title><script>alert(1)</script>' }, ['<svg></svg>']);
assert.ok(html.includes('&lt;script&gt;'));
assert.ok(!html.includes('<script>alert(1)</script>'));
assert.ok(html.includes('<section><svg></svg></section>'));
console.log('Template design model and HTML escaping checks passed.');

for (const layout of ['cards', 'comparison', 'timeline']) {
  for (const chartType of ['none', 'bar', 'line', 'doughnut']) {
    const config = { ...design, design: { ...design.design, contentLayout: layout, chartType } };
    const sample = createTemplatePreviewDeck(config);
    assert.equal(sample.slides.length, chartType === 'none' ? 3 : 4);
    assert.equal(sample.slides[1].layout, layout);
    const chart = sample.slides.flatMap(slide => slide.elements).find(e => e.type === 'chart');
    assert.equal(chart?.chartType, chartType === 'none' ? undefined : chartType);
    if (chart) {
      assert.deepEqual(chart.series[0].values, [25, 40, 35]);
      assert.ok(sample.slides[2].elements.some(e => e.type === 'text' && e.text.includes('Illustrative sample values')));
    }
  }
}
const staticHtml = createTemplateHtml({ ...design, design: { ...design.design, htmlNavigation: false } }, ['<svg></svg>']);
assert.ok(!staticHtml.includes('<script>'));
assert.ok(!staticHtml.includes('Slide navigation'));
assert.ok(html.includes('aria-label="Slide navigation"'));
assert.ok(html.includes("event.key==='ArrowRight'"));
assert.ok(templateDesignError({ ...design, design: { ...design.design, chartType: 'invalid' } }));
console.log('Shared layout, chart style, placeholder labels and HTML navigation checks passed.');

for (const htmlTransition of ['none', 'fade', 'slide']) {
  const output = createTemplateHtml({ ...design, design: { ...design.design, htmlTransition } }, ['<svg></svg>']);
  assert.ok(output.includes(htmlTransition === 'none' ? 'animation:none' : htmlTransition === 'fade' ? 'animation:templateFade .35s ease-out' : 'animation:templateSlide .35s ease-out'));
  assert.ok(output.includes('prefers-reduced-motion:reduce'));
  assert.ok(output.includes('animation:none!important'));
}
assert.ok(templateDesignError({ ...design, design: { ...design.design, htmlTransition: 'invalid' } }));
console.log('HTML transitions and reduced-motion checks passed.');

const translate = text => `Localized ${text}`;
const localizedDeck = createTemplatePreviewDeck(design, translate);
assert.equal(localizedDeck.slides[0].title, 'Localized Presentation title');
assert.equal(localizedDeck.title, design.title, 'User template name is preserved');
assert.equal(localizedDeck.slides[0].id, 'hero', 'Technical IDs remain stable');
assert.ok(localizedDeck.slides[0].elements.some(element => element.text === 'Localized A clear introduction to your story'));
const localizedHtml = createTemplateHtml(design, ['<svg></svg>'], { language: 'hi', translate });
assert.ok(localizedHtml.includes('<html lang="hi">'));
assert.ok(localizedHtml.includes('aria-label="Localized Slide navigation"'));
assert.ok(localizedHtml.includes('>Localized Previous</button>'));
const escapedLabels = createTemplateHtml(design, [], {translate: () => '<img src=x onerror=alert(1)>'});
assert.ok(escapedLabels.includes('&lt;img'));
assert.ok(!escapedLabels.includes('<img'));
console.log('Localized preview/HTML controls, stable user content and translation escaping passed.');
