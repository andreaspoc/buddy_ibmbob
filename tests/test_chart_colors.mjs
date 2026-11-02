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
const base = { type: 'bar', title: 'Department counts', labels: ['A', 'B', 'C'], data: [10, 20, 30] };
assert.equal(new Set(fills(renderChartToDOM(base))).size, 3);
assert.deepEqual(fills(renderChartToDOM(base)), fills(renderChartToDOM(base)));
assert.notDeepEqual(fills(renderChartToDOM(base)), fills(renderChartToDOM({ ...base, title: 'Price bands' })));
const colors = ['#112233', '#445566', '#778899'];
assert.deepEqual(fills(renderChartToDOM({ ...base, colors })), colors);
assert.equal(new Set(fills(renderChartToDOM({ ...base, colorMode: 'series' }))).size, 1);
assert.deepEqual(fills(renderChartToDOM({ ...base, datasets: [{ data: base.data, color: '#123456' }] })), Array(3).fill('#123456'));
assert.deepEqual(fills(renderChartToDOM({ type: 'bar', data: { labels: base.labels, datasets: [{ data: base.data, backgroundColor: colors }] } })), colors);
const pie = renderChartToDOM({ ...base, type: 'doughnut', colors });
assert.deepEqual(marks(pie, 'path').map(node => node.attributes.fill), colors);
const buttons = marks(pie, 'button').filter(button => !button.className);
buttons.forEach((button, i) => assert.ok(button.children[0].style.cssText.includes(colors[i])));
buttons[0].events.click();
assert.deepEqual(marks(pie, 'path').map(node => node.attributes.fill), colors.slice(1));
const grouped = renderChartToDOM({ ...base, colors, datasets: [{ label: 'Actual', data: [1, 2, 3] }, { label: 'Plan', data: [4, 5, 6] }] });
assert.deepEqual(fills(grouped), [colors[0], colors[1], colors[0], colors[1], colors[0], colors[1]]);
const maximize = marks(pie, 'button').find(button => button.attributes['aria-haspopup'] === 'dialog');
const dialog = marks(pie, 'dialog')[0];
maximize.events.click();
assert.equal(dialog.open, true);
assert.deepEqual(marks(dialog, 'path').map(node => node.attributes.fill), colors.slice(1));
marks(dialog, 'button').find(button => button.attributes['aria-label'] === 'Close expanded chart').events.click();
assert.equal(dialog.open, false);
assert.equal(globalThis.focused, maximize);
assert.deepEqual(marks(pie, 'path').map(node => node.attributes.fill), colors.slice(1));
assert.equal(marks(dialog, 'path').length, 0);
buttons[0].events.click();
assert.deepEqual(marks(pie, 'path').map(node => node.attributes.fill), colors);

const singleBar = renderChartToDOM({ type: 'bar', labels: ['Cat1', 'Cat2'], data: [100, 200] });
const barButtons = marks(singleBar, 'button').filter(button => !button.className);
assert.equal(barButtons.length, 2);
assert.ok(+marks(singleBar, 'rect')[0].attributes.height > 0);
barButtons[0].events.click();
assert.equal(+marks(singleBar, 'rect')[0].attributes.height, 0);
barButtons[0].events.click();
assert.ok(+marks(singleBar, 'rect')[0].attributes.height > 0);
console.log('PASS: maximize/close preserves chart nodes, hidden categories and focus restoration');
console.log('PASS: categorical defaults, stable variation, explicit colors, series overrides, Chart.js arrays, pie legend toggles and grouped series');

const crowded = renderChartToDOM({type:'bar',labels:['Example GIGA Unlimited Monthly Plan','Epic 5G Unlimited MAX Contract'],data:[15,25]});
assert.ok(marks(crowded,'tspan').length > 2);
assert.equal(marks(crowded,'title')[0].textContent,'Example GIGA Unlimited Monthly Plan');
console.log('PASS: long category labels wrap and retain full labels');
