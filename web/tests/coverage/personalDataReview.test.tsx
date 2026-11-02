// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposeEmail } from '../../src/components/ComposeEmail';
import { confirmPersonalData, postWithPersonalDataReview, installPersonalDataReview } from '../../src/lib/personalDataReview';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const held = { detail: { code: 'personal_data', categories: ['Phone number'] } };
const answer = async (label: string) => {
  await vi.waitFor(() => expect(document.querySelector('dialog ul')).toBeTruthy());
  const button = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === label);
  button!.click();
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('confirmPersonalData', () => {
  it('lists categories, resolves each choice and treats Escape as no', async () => {
    const yes = confirmPersonalData(['Phone number'], 'email');
    expect(document.querySelector('li')?.textContent).toBe('Phone number');
    await answer('Send anyway');
    await expect(yes).resolves.toBe(true);
    const no = confirmPersonalData(['Phone number'], 'file');
    await answer("Don't download");
    await expect(no).resolves.toBe(false);
    const escaped = confirmPersonalData(['Phone number'], 'file');
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await expect(escaped).resolves.toBe(false);
  });
});

describe('postWithPersonalDataReview', () => {
  it('sends directly when nothing is found', async () => {
    const request = vi.fn().mockResolvedValue(json(200, { message: 'sent' }));
    vi.stubGlobal('fetch', request);
    await expect(postWithPersonalDataReview('/x', { a: 1 }, 'failed')).resolves.toEqual({ message: 'sent' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('sends only after confirmation', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(409, held)).mockResolvedValueOnce(json(200, { message: 'sent' }));
    vi.stubGlobal('fetch', request);
    const pending = postWithPersonalDataReview('/x', { a: 1 }, 'failed');
    await answer('Send anyway');
    await expect(pending).resolves.toEqual({ message: 'sent' });
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ a: 1, personal_data_confirmed: true });
  });
  it('does not send when declined and reports failures', async () => {
    const request = vi.fn().mockResolvedValue(json(409, held));
    vi.stubGlobal('fetch', request);
    const pending = postWithPersonalDataReview('/x', {}, 'failed');
    await answer("Don't send");
    await expect(pending).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(400, { detail: 'bad' })));
    await expect(postWithPersonalDataReview('/x', {}, 'failed')).rejects.toThrow('bad');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(500, { detail: { x: 1 } })));
    await expect(postWithPersonalDataReview('/x', {}, 'failed')).rejects.toThrow('failed');
  });
});

describe('ComposeEmail', () => {
  let root: Root;
  const render = async (onClose = vi.fn()) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ComposeEmail onClose={onClose} />); });
    return onClose;
  };
  const submit = () => act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  afterEach(() => act(async () => root.unmount()));

  it('shows the result of sending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { message: 'Accepted' })));
    await render();
    await submit();
    expect(document.querySelector('[role=status]')?.textContent).toBe('Accepted');
    await submit();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('shows errors, stays open when declined, and closes on Escape or Cancel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(400, { detail: 'SMTP disabled' })));
    const onClose = await render();
    await submit();
    expect(document.querySelector('[role=alert]')?.textContent).toBe('SMTP disabled');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'));
    await submit();
    expect(document.querySelector('[role=alert]')?.textContent).toBe('Could not send email.');
    await act(async () => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    for (const [index, field] of [...document.querySelectorAll<HTMLInputElement>('input, textarea')].entries()) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
        setter.call(field, `value${index}`);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(field.value).toBe(`value${index}`);
    }
  });
  it('keeps the draft when the person declines', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(409, held)));
    await render();
    await submit();
    await act(async () => { await answer("Don't send"); });
    expect(document.querySelector('[role=status]')).toBeNull();
    expect(document.querySelector('[role=alert]')).toBeNull();
  });
});

describe('installPersonalDataReview', () => {
  const nativeClick = vi.fn();
  const review = (categories: string[]) => json(409, { detail: { categories } }, { 'X-Personal-Data-Review': 'download' });
  const server = vi.fn();
  beforeEach(() => { nativeClick.mockClear(); server.mockReset(); });

  it('reviews fetched, linked and generated downloads', async () => {
    HTMLAnchorElement.prototype.click = nativeClick;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:saved', revokeObjectURL: vi.fn() }));
    const original = window.fetch;
    window.fetch = server as typeof fetch;
    installPersonalDataReview();
    installPersonalDataReview();

    server.mockResolvedValueOnce(json(200, { ok: true })).mockResolvedValueOnce(json(409, { other: true }));
    expect((await fetch('/plain')).status).toBe(200);
    expect((await fetch('/conflict')).status).toBe(409);

    server.mockResolvedValueOnce(review(['Phone number'])).mockResolvedValueOnce(new Response('file'));
    const confirmed = fetch('/file', { headers: { A: 'b' } });
    await answer('Download anyway');
    expect(await (await confirmed).text()).toBe('file');
    expect(new Headers(server.mock.lastCall![1].headers).get('X-Personal-Data-Confirmed')).toBe('1');

    server.mockResolvedValueOnce(review(['Phone number']));
    const declined = fetch(new Request('http://localhost/file'));
    await answer("Don't download");
    expect((await declined).status).toBe(409);

    server.mockResolvedValueOnce(new Response('linked'));
    const anchor = document.createElement('a');
    anchor.href = '/report.csv'; anchor.download = 'report.csv';
    anchor.click();
    await vi.waitFor(() => expect(nativeClick).toHaveBeenCalledTimes(1));
    expect(anchor.href).toBe('blob:saved');

    const generate = (href: string) => {
      const item = document.createElement('a');
      item.href = href; item.download = 'data.csv';
      return item;
    };
    server.mockResolvedValueOnce(new Response('x')).mockResolvedValueOnce(json(200, { categories: ['Phone number'] }));
    generate('blob:data').click();
    await answer("Don't download");
    await new Promise(resolve => setTimeout(resolve));
    expect(nativeClick).toHaveBeenCalledTimes(1);

    server.mockResolvedValueOnce(new Response('x')).mockResolvedValueOnce(json(200, { categories: [] }));
    generate('blob:clean').click();
    await vi.waitFor(() => expect(nativeClick).toHaveBeenCalledTimes(2));

    server.mockResolvedValueOnce(new Response('x')).mockResolvedValueOnce(json(500, {}));
    generate('blob:error').click();
    await answer('Download anyway');
    await vi.waitFor(() => expect(nativeClick).toHaveBeenCalledTimes(3));

    server.mockResolvedValueOnce(new Response('x')).mockRejectedValueOnce(new Error('offline'));
    generate('blob:offline').click();
    await answer('Download anyway');
    await vi.waitFor(() => expect(nativeClick).toHaveBeenCalledTimes(4));

    const plain = document.createElement('a');
    plain.href = 'https://example.com/a'; plain.click();
    const external = generate('https://example.com/a');
    external.click();
    expect(nativeClick).toHaveBeenCalledTimes(6);

    server.mockResolvedValueOnce(new Response('', { status: 404 }));
    const attached = generate('/missing');
    document.body.append(attached);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    attached.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    window.fetch = original;
  });
});

describe('blocked content', () => {
  it('explains a block and offers no way to continue', async () => {
    const { notifyBlocked } = await import('../../src/lib/personalDataReview');
    const closed = notifyBlocked(['Phone number']);
    expect(document.querySelector('[role=alertdialog] li')?.textContent).toBe('Phone number');
    expect(document.querySelectorAll('dialog button')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('dialog button')!.click();
    await closed;
    const escaped = notifyBlocked(['Phone number']);
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await escaped;
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('reports the policy message when an email is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { detail: { code: 'personal_data_blocked', message: 'Not allowed' } })));
    await expect(postWithPersonalDataReview('/x', {}, 'failed')).rejects.toThrow('Not allowed');
  });
});
