import assert from 'node:assert/strict';
import {isNotesPath, navigateNotes, updateConversationUrl} from '../web/src/lib/conversationUrl.ts';
let current = new URL('https://buddy.test/?conversation=abc&project=work');
let pushes = 0;
globalThis.window = {
  get location() { return current; },
  history: {
    state: {},
    pushState(state, _, url) { this.state = state; current = new URL(url); pushes++; },
    replaceState(state, _, url) { this.state = state; current = new URL(url); },
  },
};
assert.equal(isNotesPath('/notes/'), true);
assert.equal(isNotesPath('/notes/abc'), false);
navigateNotes(true);
assert.equal(current.pathname, '/notes');
assert.equal(current.searchParams.get('conversation'), 'abc');
navigateNotes(true);
assert.equal(pushes, 1);
updateConversationUrl('next', 'work');
assert.equal(current.pathname, '/notes');
navigateNotes(false);
assert.equal(current.pathname, '/');
assert.equal(current.searchParams.get('conversation'), 'next');
current = new URL('https://buddy.test/notes/');
window.history.state = {};
navigateNotes(false);
assert.equal(current.pathname, '/');
const shared = '/shared/' + 'a'.repeat(43);
current = new URL('https://buddy.test' + shared);
navigateNotes(true);
navigateNotes(false);
assert.equal(current.pathname, shared);
console.log('Notes route helpers passed');
