const assert = require('node:assert/strict');
const { test } = require('node:test');

test('project status and timeline rendering', () => {
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/components/projectStatus.ts'), 'utf8');
const box = {exports: {}};
vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, box); // NOSONAR: intentional sandbox for isolated unit testing
for (const status of ['completed', 'done', 'resolved', 'approved', 'declined', 'accepted', 'applied', 'ACCEPTED']) {
  assert.equal(box.exports.isClosedStatus(status), true, `${status} must be closed`);
}
for (const status of ['active', 'todo', 'in_progress', 'quality_review', 'identified', 'proposed', 'blocked', 'paused']) {
  assert.equal(box.exports.isClosedStatus(status), false, `${status} must remain open`);
}
console.log('PASS terminal and open states include accepted deliverables and applied lessons');

// Render the real timeline so a regression in how the helper is used is detected.
const React = require('../node_modules/react');
const {renderToStaticMarkup} = require('../node_modules/react-dom/server');
const ganttSource = fs.readFileSync(path.join(__dirname, '../src/components/ProjectGantt.tsx'), 'utf8');
const ganttBox = {exports: {}, require: name => {
  if (name.endsWith('.css')) return {};
  if (name === './projectStatus') return box.exports;
  return require('../node_modules/' + name);
}};
vm.runInNewContext(ts.transpileModule(ganttSource, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, ganttBox); // NOSONAR: intentional sandbox for isolated unit testing
const html = renderToStaticMarkup(React.createElement(ganttBox.exports.ProjectGantt, {
  projects: [{id: 'p1', name: 'Plan', status: 'active', due_date: null}, {id: 'p2', name: 'Archived', status: 'completed', due_date: '2000-01-01'}],
  workItems: [
    {id: 't2', project_id: 'p2', kind: 'task', title: 'Historical task', status: 'todo', owner_id: null, due_date: '2000-01-01'},
    {id: 'd1', project_id: 'p1', kind: 'deliverable', title: 'Accepted product', status: 'accepted', owner_id: null, due_date: '2000-01-01'},
    {id: 'l1', project_id: 'p1', kind: 'lesson', title: 'Applied lesson', status: 'applied', owner_id: null, due_date: '2000-01-01'},
    {id: 't1', project_id: 'p1', kind: 'task', title: 'Open task', status: 'todo', owner_id: null, due_date: '2000-01-01'},
  ],
  onOpenProject() {}, onAskBob() {},
}));
assert.match(html, /<strong class="text-overdue">1<\/strong><span>Overdue<\/span>/);
for (const label of ['Accepted product', 'Applied lesson']) {
  const row = html.split('<tr').find(fragment => fragment.includes(label));
  assert.ok(row, `${label} has a timeline row`);
  assert.match(row, /status-completed/);
  assert.doesNotMatch(row, /status-overdue/);
}
const historicalRow = html.split('<tr').find(fragment => fragment.includes('Historical task'));
assert.ok(historicalRow);
assert.doesNotMatch(historicalRow, /status-overdue/);
console.log('PASS rendered timeline counts only unfinished overdue work on open projects');

});
