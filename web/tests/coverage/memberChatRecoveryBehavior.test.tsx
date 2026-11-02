// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemberChatWidget } from '../../src/components/MemberChat';

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let subscribed: boolean;
let failLeave: boolean;
let failMessage: boolean;
let messages: Array<Record<string, unknown>>;
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const click = async (button: Element | null) => { expect(button).not.toBeNull(); await act(async () => { (button as HTMLElement).click(); await pause(); }); };
const byText = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === text) || null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', class { onopen = null; onmessage = null; onclose = null; send() {} close() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollTo = vi.fn();
  subscribed = true;
  failLeave = true;
  failMessage = true;
  messages = [];
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url);
    if (path === '/api/community/rooms/2/subscribe') {
      if (failLeave) return response({ detail: 'Could not leave group' }, false);
      subscribed = false; return response({});
    }
    if (path === '/api/community/rooms') return response([{ id: 2, kind: 'channel', name: 'Team Alpha', subscribed, visibility: 'private', unread_count: 0, member_count: 2 }]);
    if (path === '/api/community/members') return response([{ username: 'alice', display_name: 'Alice Cooper' }]);
    if (path === '/api/community/away') return response({ active: false });
    if (path === '/api/notes') return response({}, false);
    if (path === '/api/community/rooms/2/messages/10' && options?.method === 'DELETE') {
      messages = messages.filter(message => message.id !== 10); return response({});
    }
    if (path === '/api/community/rooms/2/messages' && options?.method === 'POST') {
      if (failMessage) return response({ detail: 'Message rejected' }, false);
      return response({ id: 30, sender: 'tester', body: (options.body as FormData).get('body'), created_at: '2026-10-30T10:00:00Z' });
    }
    if (path.includes('/messages?')) return response(messages);
    if (path.includes('/messages') || path.includes('/receipts')) return response([]);
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); host.id = 'root'; document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openGroup() {
  await act(async () => { root.render(<MemberChatWidget username="tester" />); await pause(); });
  await act(async () => { window.dispatchEvent(new CustomEvent('community-open-room', { detail: { roomId: 2, kind: 'channel' } })); await pause(); });
  await vi.waitFor(() => expect(document.querySelector('.member-chat-composer')).not.toBeNull());
}

test('private group leave requires confirmation, retains access on failure, and retries', async () => {
  await openGroup();
  await click(byText('Leave'));
  expect(document.querySelector('.member-chat-leave-confirm')?.textContent).toContain('cannot rejoin');
  await click(byText('Stay'));
  expect(document.querySelector('.member-chat-leave-confirm')).toBeNull();
  await click(byText('Leave'));
  await click(byText('Leave group'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not leave group');
  expect(document.querySelector('.member-chat-composer')).not.toBeNull();
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/community/rooms/2/subscribe')).toHaveLength(1);
  failLeave = false;
  await click(byText('Leave group'));
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/community/rooms/2/subscribe')).toHaveLength(2);
  expect(document.querySelector('.member-chat-composer')).toBeNull();
});

test('note loading failure is visible and can be dismissed', async () => {
  await openGroup();
  await click(byText('Note'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Your notes could not be loaded');
  await click(document.querySelector('[aria-label="Dismiss error"]'));
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('failed message keeps the draft for retry and successful send clears it', async () => {
  await openGroup();
  const input = document.querySelector('textarea[aria-label="Message to Team Alpha"]') as HTMLTextAreaElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  Hello team  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(document.querySelector('.member-chat-send'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Message rejected');
  expect(input.value).toBe('  Hello team  ');
  failMessage = false;
  await click(document.querySelector('.member-chat-send'));
  expect(input.value).toBe('');
  const calls = fetchMock.mock.calls.filter(([path, options]) => path === '/api/community/rooms/2/messages' && options?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect((calls[1][1]!.body as FormData).get('body')).toBe('Hello team');
});

test('thread replies remain grouped and the composer sends to the selected root', async () => {
  messages = [
    { id: 10, sender: 'alice', sender_name: 'Alice Cooper', body: 'Parent', created_at: '2026-10-30T10:00:00Z' },
    { id: 11, parent_id: 10, sender: 'tester', body: 'Existing reply', created_at: '2026-10-30T10:01:00Z' },
  ];
  failMessage = false;
  await openGroup();
  expect(document.querySelector('.member-chat-messages')?.textContent || document.body.textContent).not.toContain('Existing reply');
  await click(document.querySelector('.people-thread-link'));
  expect(document.body.textContent).toContain('Existing reply');
  const input = document.querySelector('textarea[aria-label="Message to Team Alpha"]') as HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Reply'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(document.querySelector('.member-chat-send'));
  const call = fetchMock.mock.calls.find(([path, options]) => path === '/api/community/rooms/2/messages' && options?.method === 'POST');
  expect((call![1]!.body as FormData).get('parent_id')).toBe('10');
  await click(byText('Back to conversation'));
  expect(document.querySelector('.people-thread-heading')).toBeNull();
});

test('emoji insertion and oversized attachment validation preserve the draft', async () => {
  await openGroup();
  await click(document.querySelector('[aria-label="Add emoji"]'));
  await click(document.querySelector('[aria-label="Smile"]'));
  const input = document.querySelector('textarea[aria-label="Message to Team Alpha"]') as HTMLTextAreaElement;
  expect(input.value).toContain('😊');
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'too-large.txt');
  Object.defineProperty(file, 'size', { value: 20 * 1024 * 1024 + 1 });
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
  await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('20 MB or smaller');
  expect(input.value).toContain('😊');
});

test('message deletion can be cancelled before confirming the destructive action', async () => {
  messages = [{ id: 10, sender: 'tester', body: 'My message', created_at: '2026-10-30T10:00:00Z' }];
  await openGroup();
  await click(document.querySelector('[aria-label="Delete message"]'));
  expect(document.querySelector('.member-chat-delete-confirm')?.textContent).toContain('Permanently delete');
  await click(byText('Cancel'));
  expect(document.querySelector('.member-chat-delete-confirm')).toBeNull();
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/community/rooms/2/messages/10' && options?.method === 'DELETE')).toBe(false);
  await click(document.querySelector('[aria-label="Delete message"]'));
  await click(byText('Delete'));
  expect(fetchMock.mock.calls.some(([path, options]) => path === '/api/community/rooms/2/messages/10' && options?.method === 'DELETE')).toBe(true);
  expect(document.body.textContent).not.toContain('My message');
});

test('saving a message as a private note explains the source deletion link', async () => {
  messages = [{ id: 10, sender: 'alice', sender_name: 'Alice', body: 'Useful detail', created_at: '2026-10-30T10:00:00Z' }];
  await openGroup();
  await click(document.querySelector('[aria-label="Message actions"]'));
  await click(byText('Save as private note'));
  const request = fetchMock.mock.calls.find(([path]) => path === '/api/community/rooms/2/messages/10/save-note');
  expect(request?.[1]?.method).toBe('POST');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ title: 'Useful detail' });
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Deleting the source removes this copy');
});
