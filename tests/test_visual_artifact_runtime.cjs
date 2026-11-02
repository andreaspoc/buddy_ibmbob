/* Lifecycle coverage without network; the library boundary is intentionally stubbed. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/visual_artifact_runtime.js', 'utf8');
function environment(fail = false) {
  let instance, mutation, mediaChange, resize;
  let loads = 0;
  class Element {
    constructor() { this.isConnected = true; this.clientWidth = 600; this.clientHeight = 300; this.attrs = {}; }
    setAttribute(k,v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    remove() {}
  }
  const motion = {matches: true, addEventListener(_, fn) { mediaChange = fn; }, removeEventListener() {}};
  const window = {matchMedia: () => motion, addEventListener() {}};
  const library = {init() {
    instance = {options: {}, disposed: false, resized: 0,
      setOption(o) { this.options = {...this.options, ...o}; },
      getOption() { return this.options; }, resize() { this.resized++; }, dispose() { this.disposed = true; }};
    return instance;
  }};
  const document = {documentElement: {}, createElement: () => new Element(), head: {appendChild(script) {
    loads++;
    queueMicrotask(() => { if (fail) script.onerror(); else { window.echarts = library; script.onload(); } });
  }}};
  vm.runInNewContext(source, {window, document, HTMLElement: Element, Map, WeakMap, Promise,
    setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} disconnect() {} },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} }});
  return {window, Element, motion, get instance() {return instance;}, get loads() {return loads;},
    changeMotion() {mediaChange();}, remove() {mutation();}, resize() {resize();}};
}
(async () => {
  const env = environment();
  assert.equal(env.loads, 0, 'scaffold must not fetch a library until requested');
  const element = new env.Element();
  const handle = await env.window.BobVisuals.echarts(element, {series: [{id: 'observed', type: 'scatter', data: []}]});
  assert.equal(env.loads, 1);
  assert.equal(env.instance.options.animation, false);
  assert.equal(env.instance.options.series[0].animation, false);
  assert.equal(element.attrs['aria-busy'], undefined);
  env.motion.matches = false;
  env.changeMotion();
  assert.equal(env.instance.options.series[0].animation, true);
  handle.update({series: [{id: 'observed', data: [[1,2]]}]});
  assert.equal(env.instance.options.series[0].data[0][1], 2);
  env.resize(); env.resize();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(env.instance.resized, 1, 'resize events coalesce into one frame');
  element.isConnected = false;
  env.remove();
  assert.equal(env.instance.disposed, true);
  const offline = environment(true);
  const failed = new offline.Element();
  await assert.rejects(offline.window.BobVisuals.echarts(failed, {}));
  assert.match(failed.textContent, /unavailable/);
  assert.equal(failed.attrs['aria-busy'], undefined);
  await assert.rejects(offline.window.BobVisuals.echarts(failed, {}));
  assert.equal(offline.loads, 2, 'failed loads can be retried');
  console.log('Visual artifact runtime lifecycle checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
