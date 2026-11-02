// Synthetic failure and parsing fixtures exercise the actual production functions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

function componentFixture(filename, overrides = {}) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const states = [], refs = [], writes = [], effects = [];
  let stateCursor = 0, refCursor = 0;
  const stateOverrides = overrides.states || {};
  const context = { exports: {}, window: { scrollTo() {} }, document: {},
    setTimeout: () => 1, clearTimeout() {}, console, ...overrides };
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = index in stateOverrides ? stateOverrides[index] : initial;
      return [states[index], update => { states[index] = typeof update === 'function' ? update(states[index]) : update; writes.push(index); }];
    },
    useRef(initial) { const index = refCursor++; return refs[index] || (refs[index] = { current: initial }); },
    useCallback: callback => callback,
    useEffect: callback => effects.push(callback),
    useLayoutEffect: callback => callback(),
  };
  for (const statement of source.statements.filter(ts.isImportDeclaration)) {
    const clause = statement.importClause;
    if (!clause) continue;
    const names = [clause.name?.text, ...(clause.namedBindings?.elements || []).map(item => item.name.text)].filter(Boolean);
    for (const name of names) context[name] ??= react[name] || function fixtureComponent() {};
  }
  context.React = react;
  const selected = source.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(source)).join('\n');
  vm.runInNewContext(ts.transpileModule(selected, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText, context, { filename });
  return {
    states, refs, writes, effects, context,
    render(props) { stateCursor = 0; refCursor = 0; effects.length = 0; return context.exports.default(props); },
  };
}

function elements(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(item => elements(item, predicate));
  return [...(predicate(node) ? [node] : []), ...elements(node.props?.children, predicate)];
}

async function main() {
  const audit = componentFixture('decisions-buddy/src/components/AuditLogsTab.jsx', {
    fetch: async () => { throw new Error('Synthetic audit service unavailable'); }, API_BASE: '',
  });
  audit.render({ backendConnected: true });
  audit.effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(audit.states[2], /Synthetic audit service unavailable/);
  assert.equal(audit.states[1], false);

  const flow = componentFixture('decisions-buddy/src/components/BobFlowDesigner.jsx', {
    apiRequest: async () => { throw new Error('Synthetic flow service unavailable'); },
  });
  const flowTree = flow.render({ isOpen: true });
  const preset = elements(flowTree, node => node.props?.renderIcon && node.props?.onClick)[0];
  preset.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(flow.states[2], /Synthetic flow service unavailable/);
  assert.equal(flow.states[1], false);

  let scrolls = 0;
  const toc = componentFixture('decisions-buddy/src/components/PageTableOfContents.jsx', {
    window: { scrollTo: () => { scrolls++; } },
  });
  const buttons = elements(toc.render({ activeTab: 1 }), node => node.type === 'button');
  assert.equal(buttons.length, 6);
  for (const button of buttons) { assert.equal(button.props.type, 'button'); assert.equal(typeof button.props.onClick, 'function'); }
  buttons[0].props.onClick();
  assert.equal(scrolls, 1);

  const graph = { nodes: [{ id: 'input', type: 'inputNode', content: {} }], edges: [] };
  let saved;
  const canvas = componentFixture('decisions-buddy/src/components/canvas/VisualGraphEditor.jsx', {
    MODERN_TYPES: ['forkNode'],
    applyNodeChanges: (changes, nodes) => nodes.map(node => ({ ...node, position: changes[0].position })),
  });
  const props = { model: { graph }, editable: true, onSaveGraph: value => { saved = value; } };
  const first = canvas.render(props);
  const canvasElement = elements(first, node => typeof node.props?.onNodesChange === 'function')[0];
  canvasElement.props.onNodesChange([{ id: 'input', type: 'position', position: { x: 400, y: 200 } }]);
  assert.ok(saved);
  assert.equal(saved.graph.nodes[0].position.x, 400);
  canvas.writes.length = 0;
  canvas.render({ ...props, model: saved });
  canvas.effects[0]();
  assert.deepEqual(canvas.writes, [], 'parent echo must preserve the existing canvas');
  canvas.render({ ...props, model: saved, editable: false });
  canvas.effects[0]();
  assert.equal(canvas.states[1][0].data.editable, false, 'permission changes must still update the canvas');

  const legacySource = ts.createSourceFile('app.js', fs.readFileSync('app/static/app.js', 'utf8'), ts.ScriptTarget.Latest, true);
  const helpers = legacySource.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && ['bobDeckFilename', 'skillPromptCommand'].includes(statement.name?.text)).map(statement => statement.getText(legacySource)).join('\n');
  const parsing = vm.createContext({});
  vm.runInContext(helpers, parsing);
  for (const input of ['report.bobdeck', 'folder/Report.BOBDECK', 'İ file.bobdeck', '.bobdeck.bobdeck', 'none', 'a b-c_2.bobdeck.json']) {
    const previous = input.match(/([a-zA-Z0-9_-]+\.bobdeck)/i)?.[1] || null;
    assert.equal(parsing.bobDeckFilename(input), previous);
  }
  for (const input of ['/quiz', '/quiz  learn this', '/a-b\nmultiline\ntext', '/Invalid input', '/foo!', 'ordinary']) {
    const previous = input.match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
    const actual = parsing.skillPromptCommand(input);
    assert.equal(JSON.stringify(actual), JSON.stringify(previous && Array.from(previous)));
  }
  vm.runInContext("if (bobDeckFilename('x'.repeat(200000)) !== null) throw Error('unexpected deck'); if (skillPromptCommand('/quiz ' + ' '.repeat(200000))[2] !== '') throw Error('unexpected prompt');", parsing, { timeout: 2000 });
  console.log('PASS decision UI failure handling, native TOC controls, graph echoes/permissions, null editor rendering and linear legacy parsing');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
