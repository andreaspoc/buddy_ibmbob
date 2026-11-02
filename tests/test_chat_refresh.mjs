import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const start = source.indexOf('  const refreshPages = () =>');
const end = source.indexOf('\n  useEffect', start);
let pages = ['presentation.html'], files = ['presentation.html'];
const selectedSessionRef = {current: 'existing'};
let resolvePages;
let api = {fetchPages: () => Promise.reject(new Error('offline')), fetchSessionFiles: () => Promise.reject(new Error('offline'))};
const refresh = new Function('api', 'selectedSessionRef', 'setPages', 'setFiles', compile(source.slice(start,end)) + ';return refreshPages;')(api, selectedSessionRef, value => pages=value, value => files=value);
refresh();
await new Promise(resolve => setTimeout(resolve,0));
assert.deepEqual(pages,['presentation.html']);
assert.deepEqual(files,['presentation.html']);
api.fetchPages = () => new Promise(resolve => resolvePages=resolve);
refresh();
selectedSessionRef.current = 'another';
resolvePages(['old-conversation.html']);
await new Promise(resolve => setTimeout(resolve,0));
assert.deepEqual(pages,['presentation.html']);
const resetStart = source.indexOf("      // Every page load starts a blank personal chat.");
const resetEnd = source.indexOf('\n    } catch (err)', resetStart);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
for (const inProject of [false, true]) {
  let selectedProject = inProject ? 'project' : '';
  let newChatOpened = false;
  const env = {
    sessionStorage: {getItem: () => {throw new Error('Refresh must not restore a saved chat');}},
    loadSessionHistory: () => {throw new Error('Refresh must not load an old response');},
    api: {createSession: () => {throw new Error('Blank chats are created on first send');}},
    setSelectedProjectId: id => selectedProject = id,
    handleNewChat: () => newChatOpened = true,
  };
  await new AsyncFunction(...Object.keys(env), compile(source.slice(resetStart, resetEnd)))(...Object.values(env));
  assert.equal(selectedProject, '');
  assert.equal(newChatOpened, true);
}
console.log('Fresh chat on reload and artifact refresh checks passed');
