import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../web/src/components/MapRenderer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace("'../lib/motion'", JSON.stringify(new URL('../web/src/lib/motion.ts', import.meta.url).href)), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.events = {};
  }
  appendChild(child) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter(item => item !== child);
    }
    child.parentElement = this;
    this.children.push(child);
  }
  append(...children) {
    children.forEach(child => this.appendChild(child));
  }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() { globalThis.focused = this; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  set textContent(value) { this._textContent = value; }
  get textContent() {
    if (this._textContent !== undefined) return this._textContent;
    return this.children.map(c => c.textContent).join('');
  }
  set innerHTML(value) { this.children = []; this._innerHTML = value; }
  get innerHTML() { return this._innerHTML ?? ''; }
}

globalThis.document = {
  createElement: tag => new Element(tag),
  createElementNS: (_, tag) => new Element(tag)
};

const { renderMapToDOM } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const descendants = el => [el, ...el.children.flatMap(descendants)];
const findByClass = (el, cls) => descendants(el).filter(node => node.className && node.className.includes(cls));

// Test 1: Standard Map with multiple locations
const spec = {
  title: 'Specialty Coffee in Rome',
  subtitle: 'Historic & artisanal roasters',
  center: [41.9028, 12.4964],
  zoom: 14,
  places: [
    {
      name: "Sant' Eustachio Il Caffè",
      lat: 41.8981,
      lng: 12.4754,
      category: 'Historic Café',
      rating: 4.6,
      address: 'Piazza di S. Eustachio, 82'
    },
    {
      name: 'Faro - Luminari del Caffè',
      lat: 41.9084,
      lng: 12.4988,
      category: 'Specialty Roaster',
      rating: 4.8,
      address: 'Via Piave, 55'
    }
  ]
};

const mapCard = renderMapToDOM(spec);
assert.equal(mapCard.className, 'interactive-map-card');

const title = descendants(mapCard).find(n => n.tag === 'h4');
assert.equal(title.textContent, 'Specialty Coffee in Rome');

const subtitle = descendants(mapCard).find(n => n.tag === 'p');
assert.equal(subtitle.textContent, 'Historic & artisanal roasters');

const badge = descendants(mapCard).find(n => n.textContent === '2 LOCATIONS');
assert.ok(badge, 'Location count badge should be present');

const fitBtn = descendants(mapCard).find(n => n.textContent === '⌖ Fit All');
assert.ok(fitBtn, 'Fit All button should be present');

const maximizeBtn = descendants(mapCard).find(n => n.className === 'map-maximize-button');
assert.ok(maximizeBtn, 'Maximize button should be present');

const placeCards = findByClass(mapCard, 'map-place-card');
assert.equal(placeCards.length, 2, 'Should create 2 place cards');
assert.ok(placeCards[0].textContent.includes("Sant' Eustachio"), 'First place card should have place name');
assert.ok(placeCards[1].textContent.includes('Faro'), 'Second place card should have place name');

// Test 2: Empty places
const emptyMap = renderMapToDOM({ title: 'Empty Map', places: [] });
assert.ok(descendants(emptyMap).some(n => n.textContent.includes('No map coordinates provided.')));

console.log('PASS: MapRenderer renders title, badges, action buttons, place cards, and handles empty state gracefully');
