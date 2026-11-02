import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transpile} from './frontend_transpile.mjs';
for (const format of ['html', 'bobdeck']) {
  const source = readFileSync(new URL(format === 'html' ? '../web/src/mods/PresentationPreviewPanel.tsx' : '../web/src/components/WorkspaceDeckViewer.tsx', import.meta.url), 'utf8');
  const start = source.indexOf(format === 'html' ? '  const saveHtml = async' : '  async function saveJson');
  const end = source.indexOf(format === 'html' ? '  const fullscreenPage' : '  if (error)', start);
  let version = 'baseline'; let refreshed = 0; let fail = false; const requests = [];
  const fetch = async (url, options) => { requests.push({url, ...JSON.parse(options.body)}); return {ok: !fail, json: async () => fail ? {detail: 'Version conflict'} : {content: 'new content',sha256: 'new-version'}}; };
  const env = {fetch, savedSource: {sha256: version}, sha256: version, selectedFile: 'my deck.html', filename: 'my deck.bobdeck', sessionId:'session', sourceUrl:'/sessions/session/artifacts/source', setSavedSource:value => version=value.sha256, setSha256:value => version=value, onRefreshPages:() => refreshed++};
  const save = new Function(...Object.keys(env), transpile(source.slice(start,end)) + `;return ${format === 'html' ? 'saveHtml' : 'saveJson'};`)(...Object.values(env));
  await save('new content');
  assert.equal(requests[0].path, format === 'html' ? 'my deck.html' : 'my deck.bobdeck');
  assert.equal(requests[0].expected_sha256,'baseline'); assert.equal(version,'new-version');
  fail = true; await assert.rejects(save('another edit'), /Version conflict/);
  assert.equal(version,'new-version', 'Conflicts must not advance saved version');
  assert.equal(refreshed,format === 'html' ? 1 : 0);
}
console.log('Studio exact-file saves and conflict handling passed for HTML and deck sources.');
