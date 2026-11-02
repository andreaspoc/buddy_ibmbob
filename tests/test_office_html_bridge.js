/* Live bridge boundaries with a minimal document fixture; no browser services. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');
const source = fs.readFileSync(require.resolve('../web/src/lib/officeHtmlBridge.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exported = {};
vm.runInNewContext(compiled, {
  exports: exported, Event,
  require(name) {
    assert.equal(name, 'react');
    return { useCallback: fn => fn, useEffect() {}, useState: initial => [initial, () => {}] };
  },
});
function fixture(values = ['First slide', 'Second slide'], readOnly = false) {
  const nodes = values.map((text, index) => ({ textContent: text, parentElement: {
    tagName: 'P', closest: () => index === values.length - 1 && text === 'SCRIPT_TEXT' ? {} : null,
  } }));
  let fired = 0;
  const script = '<script>window.originalScript = true;</script>';
  const doc = {
    body: {}, getSelection: () => ({ toString: () => 'selected' }),
    createTreeWalker() { let cursor = 0; return { nextNode: () => nodes[cursor++] || null }; },
    documentElement: { get outerHTML() { return '<html><body>' + JSON.stringify(nodes.map(node => node.textContent)) + script + '</body></html>'; } },
    dispatchEvent(event) { assert.equal(event.type, 'buddy-html-edited'); fired++; },
  };
  const host = { current: { querySelector: () => ({ contentDocument: doc }) } };
  return { bridge: exported.useOfficeHtmlBridge(host, 'test-file', readOnly), nodes, doc, script, fired: () => fired };
}
const plan = actions => ({ version: 1, kind: 'html', reply: 'Review edits', actions });
const action = (index, old_text, text) => ({ type: 'html_update_text', index, old_text, text });
(async () => {
  {
    const { bridge } = fixture(['x'.repeat(31000)]);
    const snapshot = await bridge.context();
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.text.length, 30000);
  }

  {
    const { bridge } = fixture(['Alpha', 'Beta', 'SCRIPT_TEXT']);
    const context = await bridge.context();
    assert.equal(context.kind, 'html');
    assert.deepEqual(Array.from(context.html_nodes, item => [item.index, item.text, item.tag]), [[1, 'Alpha', 'p'], [2, 'Beta', 'p']]);
    assert.equal(context.selection, 'selected');
    assert(!context.text.includes('SCRIPT_TEXT'));
  }
  {
    const { bridge } = fixture(Array.from({ length: 300 }, () => 'x'));
    assert.equal((await bridge.context()).html_nodes.length, 200);
    const large = await fixture(Array.from({ length: 300 }, () => 'x'.repeat(3999))).bridge.context();
    assert(large.html_nodes.reduce((total, item) => total + item.text.length, 0) <= 30000);
    assert(large.text.length <= 30000);
    const offset = await fixture([...Array.from({ length: 2000 }, () => 'x'.repeat(4001)), 'Hidden by index limit']).bridge.context();
    assert.equal(offset.html_nodes.length, 0);
  }
  {
    const item = fixture(); const context = await item.bridge.context();
    item.nodes[0].textContent = 'Changed independently';
    await assert.rejects(item.bridge.apply(plan([action(2, 'Second slide', 'New')]), context), /presentation changed/);
    assert.equal(item.nodes[1].textContent, 'Second slide'); assert.equal(item.fired(), 0);
  }
  {
    const item = fixture(); const context = await item.bridge.context();
    await assert.rejects(item.bridge.apply(plan([action(1, 'First slide', 'New'), action(2, 'Incorrect old text', 'Another')]), context), /safely/);
    assert.equal(item.nodes[0].textContent, 'First slide'); assert.equal(item.fired(), 0);
    await assert.rejects(item.bridge.apply(plan([action(1, 'First slide', 'One'), action(1, 'First slide', 'Two')]), context), /safely/);
    await assert.rejects(item.bridge.apply(plan([{ type: 'replace_document', text: '<script>bad()</script>' }]), context), /safely/);
    await assert.rejects(item.bridge.apply(plan([action(0, 'First slide', 'No')]), context), /safely/);
    assert.equal(item.nodes[0].textContent, 'First slide');
  }
  {
    const item = fixture(); const context = await item.bridge.context();
    const literal = '<script>alert(1)</script><b>literal markup</b>';
    const result = await item.bridge.apply(plan([action(1, 'First slide', literal)]), context);
    assert.equal(result.applied, 1); assert.equal(item.nodes[0].textContent, literal);
    assert(item.doc.documentElement.outerHTML.includes(item.script));
    assert.equal(item.fired(), 1);
  }
  {
    const item = fixture(undefined, true); const context = await item.bridge.context();
    await assert.rejects(item.bridge.apply(plan([action(1, 'First slide', 'No')]), context), /read only/);
    assert.equal(item.nodes[0].textContent, 'First slide');
  }
  console.log('Office HTML bridge tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
