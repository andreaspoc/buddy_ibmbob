/** Run the actual action form handlers with mocked HTTP; no emails are sent. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
let slots = [], cursor = 0;
globalThis.__actionHooks = {
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
  useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
};
globalThis.__jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
let source = readFileSync(new URL('../web/src/components/InteractiveAction.tsx', import.meta.url), 'utf8')
  .replace(/import .* from 'react';/, 'const {useState,useRef} = globalThis.__actionHooks;')
  .replace(/import .* from '..\/lib\/i18n';/, 'const t = value => value;');
let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
code = code.replace(/import .* from "react\/jsx-runtime";/, 'const {jsx:_jsx,jsxs:_jsxs} = globalThis.__jsx; const _Fragment = "fragment";');
const { InteractiveAction: component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
const render = props => { cursor = 0; return component(props); };
const props = { title: 'Synthetic test draft', body: 'Original', operation: 'email_note', sessionId: 'a'.repeat(32) };
let calls = [], release;
globalThis.fetch = (url, options) => { calls.push({ url, options }); return new Promise(resolve => { release = resolve; }); };
const submit = tree => tree.props.onSubmit({ preventDefault() {} });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
let tree = render(props); assert.equal(calls.length, 0, 'rendering never sends');
const text = descendants(tree).find(node => node.type === 'textarea');
text.props.onChange({ target: { value: 'Reviewed content' } });
tree = render(props);
const email = descendants(tree).find(node => node.props?.type === 'email');
email.props.onChange({ target: { value: 'me@example.com' } });
tree = render(props); submit(tree); submit(tree);
assert.equal(calls.length, 1, 'double click submits once');
assert.deepEqual(JSON.parse(calls[0].options.body), {session_id: props.sessionId, action: 'email_note', title: props.title, body: 'Reviewed content', recipient: 'me@example.com'});
release({ ok: true, json: async () => ({ message: 'Accepted by SMTP' }) }); await flush();
tree = render(props); submit(tree); assert.equal(calls.length, 1, 'success cannot be submitted again');
slots = []; calls = [];
tree = render({...props, disabled: true}); submit(tree); assert.equal(calls.length, 0);
slots = []; tree = render({...props, sessionId: undefined}); submit(tree); assert.equal(calls.length, 0);
slots = []; tree = render(props); submit(tree);
release({ ok: false, json: async () => ({detail: 'SMTP disabled'}) }); await flush();
render(props); await flush(); assert.equal(calls.length, 1, 'failed submission is never automatically retried');
console.log('PASS: actions require explicit click, use reviewed content, prevent duplicate submissions and never auto-retry');
