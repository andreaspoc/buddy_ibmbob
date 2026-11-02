// Exercise production legacy UI handlers with rejected network/action promises.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');
const filename = path.join(__dirname, '../app/static/app.js');
const source = fs.readFileSync(filename, 'utf8');
const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['reportUiError', 'startNewChat'].includes(node.name?.text)).map(node => node.getText(parsed));
const handlerPrefixes = ['form.addEventListener("submit"', 'promptInput.addEventListener("keydown"',
  'byId("new-chat").', 'byId("refresh-pages").', 'byId("preview-refresh").'];
const registrations = parsed.statements.filter(node => handlerPrefixes.some(prefix => node.getText(parsed).startsWith(prefix)))
  .map(node => node.getText(parsed));
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { textContent: '', attributes: {}, value: 'fixture prompt', handlers: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
  });
  return elements.get(id);
}
const logs = [];
const fixture = {
  byId: element, form: element('form'), promptInput: element('prompt'),
  console: { error: (...args) => logs.push(args) }, busy: false,
  updateTokenPill() {}, currentProjectId: '', sessionTokensTotal: 0, sessionCostTotal: 0,
  previewPath: 'fixture.html', slashMenu: { classList: { add() {} } },
  sendPrompt: async () => { throw new Error('Synthetic send failure'); },
  loadPages: async () => { throw new Error('Synthetic page failure'); },
  openPreview: async () => { throw new Error('Synthetic preview failure'); },
  loadSessions: async () => { throw new Error('Synthetic sessions failure'); },
  switchSession: async () => { throw new Error('Must not switch after failed creation'); },
  fetch: async () => ({ ok: false, status: 503 }),
};
vm.createContext(fixture);
vm.runInContext([...functions, ...registrations].join('\n'), fixture, { filename });
async function rejectedAction(target, type, event, expected) {
  await element(target).handlers[type](event);
  // Dispatchers do not await listeners; allow detached handlers to settle too.
  await new Promise(resolve => setImmediate(resolve));
  assert.match(element('sidebar-status').textContent, expected);
  assert.equal(element('sidebar-status').attributes.role, 'alert');
  assert.equal(element('sidebar-dot').className, 'status-dot error');
}
(async () => {
  await rejectedAction('form', 'submit', { preventDefault() {} }, /Send message failed.*Synthetic send failure/);
  await rejectedAction('prompt', 'keydown', { key: 'Enter', preventDefault() {} }, /Send message failed/);
  await rejectedAction('new-chat', 'click', {}, /Create conversation failed.*HTTP 503/);
  fixture.fetch = async () => { throw new Error('Synthetic offline'); };
  await rejectedAction('new-chat', 'click', {}, /Create conversation failed.*Synthetic offline/);
  await rejectedAction('refresh-pages', 'click', {}, /Refresh workspace pages failed.*Synthetic page failure/);
  await rejectedAction('preview-refresh', 'click', {}, /Refresh preview failed.*Synthetic preview failure/);
  assert.equal(logs.length, 6);
  fixture.fetch = async () => ({ ok: true, json: async () => ({ id: 'created-fixture' }) });
  await rejectedAction('new-chat', 'click', {}, /Create conversation failed.*Synthetic sessions failure/);
  console.log('PASS legacy UI reports rejected send, creation, refresh and preview actions');
})().catch(error => { console.error(error); process.exitCode = 1; });
