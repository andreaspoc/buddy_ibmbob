import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../web/src/components/ChartRenderer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace("'../lib/motion'", JSON.stringify(new URL('../web/src/lib/motion.ts', import.meta.url).href)), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { renderChartToDOM } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.events = {}; }
  appendChild(child) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
    child.parentElement = this;
    this.children.push(child);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 100 }; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() { globalThis.focused = this; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  set innerHTML(value) { this.children = []; }
}
globalThis.document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
const descendants = el => [el, ...el.children.flatMap(descendants)];
const marks = (el, tag) => descendants(el).filter(node => node.tag === tag);
const fills = el => marks(el, 'rect').map(node => node.attributes.fill);

const mixed = renderChartToDOM({ type: 'bar', labels: ['Loss', 'Gain', 'Zero'], data: [-10, 20, 0] });
const bars = marks(mixed, 'rect');
assert.ok(+bars[0].attributes.height > 0);
assert.ok(+bars[0].attributes.y > +bars[1].attributes.y);
assert.equal(+bars[2].attributes.height, 0);
assert.ok(marks(mixed, 'text').some(node => node.textContent === '-10'));
assert.equal(marks(mixed, 'svg')[0].attributes.role, 'img');
const inferred = renderChartToDOM({ type: 'line', data: [5] });
assert.equal(marks(inferred, 'circle')[0].attributes.cx, '260');
assert.ok(marks(inferred, 'svg')[0].attributes['aria-label'].includes('Item 1 5'));
for (const type of ['pie', 'doughnut']) {
  const chart = renderChartToDOM({type, data: [12]});
  assert.equal(marks(chart, 'path').length, 1);
  const toggle = marks(chart, 'button').find(node => node.attributes['aria-pressed']);
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  toggle.events.click();
  assert.equal(globalThis.focused.attributes['aria-pressed'], 'false');
}
const invalid = renderChartToDOM({data: [NaN]});
assert.equal(marks(invalid, 'svg').length, 0);
const unsafe = '<img src=x onerror=alert(1)>';
const tooltipChart = renderChartToDOM({labels:[unsafe], datasets:[{label:unsafe,data:[5]}]});
marks(tooltipChart, 'rect')[0].events.mouseenter({clientX:290,clientY:20});
const tooltip = descendants(tooltipChart).find(node => node.className === 'chart-interactive-tooltip');
assert.equal(tooltip.children[0].textContent, unsafe);
assert.equal(marks(tooltip, 'img').length, 0);
assert.ok(parseFloat(tooltip.style.left) >= 0);
console.log('PASS: signed values, zero bars, implicit labels, singleton lines, accessible legends, invalid data and safe bounded tooltips');
