import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
function load(path, customRequire = require) {
 const exports = {};
 const code = ts.transpileModule(fs.readFileSync(new URL('../web/' + path, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
 new Function('exports', 'require', code)(exports, customRequire);
 return exports;
}
const parser = load('src/lib/clarification.ts');
let state = [];
let index = 0;
const {ClarificationCard} = load('src/components/ClarificationCard.tsx', name => name.endsWith('.css') ? {} : name === '../lib/i18n' ? {t: text => text} : name === '../lib/clarification' ? parser : name === 'react' ? {...React, useState: () => [state[index++], () => {}], useId: () => 'form-test', useRef: () => ({current:false})} : require(name));
const questions = [{question:'Audience?', options:['Executives','Engineers']}, {question:'Length?', options:['Brief','Detailed']}];
let submitted = '';
function card(choices={}, custom={}, extra={}) {
 state = [choices, custom]; index = 0;
 return ClarificationCard({questions, disabled:false, answered:false, onReply:text=> {submitted=text;}, ...extra});
}
const html = tree => renderToStaticMarkup(tree);
assert.match(html(card()), /button[^>]*disabled/);
assert.doesNotMatch(html(card()), /checked/);
assert.match(html(card({0:'option:Executives'})), /button[^>]*disabled/);
const ready = card({0:'option:Executives',1:'option:Detailed'});
assert.doesNotMatch(html(ready), /button[^>]*disabled/);
ready.props.onSubmit({preventDefault(){}});
assert.match(submitted, /Audience\?[\s\S]*Executives[\s\S]*Length\?[\s\S]*Detailed/);
assert.match(html(card({0:'custom',1:'option:Brief'})), /textarea/);
assert.match(html(card({0:'custom',1:'option:Brief'})), /button[^>]*disabled/);
card({0:'custom',1:'option:Brief'},{0:' Mixed audience '}).props.onSubmit({preventDefault(){}});
assert.match(submitted, /Mixed audience/);
assert.doesNotMatch(html(card({}, {}, {answered:true})), /<button/);
assert.match(html(card({}, {}, {answered:true})), /fieldset disabled/);
submitted = '';
card({0:'option:Executives',1:'option:Brief'}, {}, {disabled:true}).props.onSubmit({preventDefault(){}});
assert.equal(submitted, '');
// Cancellation tests
submitted = '';
const cancelCard = card();
assert.match(html(cancelCard), /Cancel Form/);
assert.doesNotMatch(html(cancelCard), /Cancel form ✕/);
const cancelActions = cancelCard.props.children[2];
const cancelBtn = cancelActions.props.children.find(child => child?.props?.className === 'clarification-cancel-btn');
cancelBtn.props.onClick();
assert.match(submitted, /cancelled this clarification form/);
assert.match(html(card({}, {}, {answered:true, cancelled:true})), /Form cancelled/);
console.log('Question card render and submission checks passed');


// Selection is separate from submission, including pointer double clicks.
const designCard = card({}, {}, {questions: [{question: 'Audience?', context: 'Choose who will read it.', options: ['Executives', 'Engineers']}]});
const designHtml = html(designCard);
assert.match(designHtml, /aria-describedby="form-test-context-0"/);
assert.match(designHtml, /id="form-test-context-0"/);
assert.match(designHtml, /<progress/);
const fieldset = designCard.props.children[1].props.children[0];
const tiles = fieldset.props.children[1].props.children[1].props.children[0];
assert.equal(tiles[0].props.onDoubleClick, undefined);
console.log('Follow-up design checks passed: context association, native progress, explicit submission');
