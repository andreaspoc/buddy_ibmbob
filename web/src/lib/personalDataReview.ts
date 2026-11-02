import { t } from './i18n';

const CONFIRM_HEADER = 'X-Personal-Data-Confirmed';
const REVIEW_HEADER = 'X-Personal-Data-Review';
const SCAN_URL = '/api/email/scan-file';
const UNCHECKED = 'Content that could not be checked';

export type ReviewKind = 'email' | 'file' | 'share';
const WORDING: Record<ReviewKind, [string, string, string]> = {
  email: ['This email may contain personal data', "Don't send", 'Send anyway'],
  file: ['This file may contain personal data', "Don't download", 'Download anyway'],
  share: ['This conversation may contain personal data', "Don't share", 'Share anyway'],
};

/** Ask the signed-in person directly. This dialog is the only way to confirm from the browser. */
export function confirmPersonalData(categories: string[], kind: ReviewKind): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'notes-editor';
    dialog.setAttribute('aria-labelledby', 'personal-data-review-title');
    const heading = document.createElement('h2');
    heading.id = 'personal-data-review-title';
    heading.textContent = t(WORDING[kind][0]);
    const list = document.createElement('ul');
    for (const category of categories) {
      const item = document.createElement('li');
      item.textContent = t(category);
      list.append(item);
    }
    const actions = document.createElement('div');
    actions.className = 'notes-revision-actions';
    const finish = (decision: boolean) => { dialog.close(); dialog.remove(); resolve(decision); };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t(WORDING[kind][1]);
    cancel.onclick = () => finish(false);
    const proceed = document.createElement('button');
    proceed.type = 'button';
    proceed.textContent = t(WORDING[kind][2]);
    proceed.onclick = () => finish(true);
    actions.append(cancel, proceed);
    dialog.append(heading, list, actions);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/** Tell the person a policy stopped this. There is deliberately no way to continue. */
export function notifyBlocked(categories: string[]): Promise<void> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'notes-editor';
    dialog.setAttribute('role', 'alertdialog');
    const heading = document.createElement('h2');
    heading.textContent = t('Blocked by your data protection policy');
    const list = document.createElement('ul');
    for (const category of categories) {
      const item = document.createElement('li');
      item.textContent = t(category);
      list.append(item);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = t('Close');
    const finish = () => { dialog.close(); dialog.remove(); resolve(); };
    close.onclick = finish;
    dialog.oncancel = event => { event.preventDefault(); finish(); };
    dialog.append(heading, list, close);
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  });
}

/** Post an email request; returns null when the person chose not to send. */
export async function postWithPersonalDataReview(url: string, payload: Record<string, unknown>, fallback: string): Promise<{ message: string } | null> {
  const post = (body: Record<string, unknown>) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let response = await post(payload);
  let data = await response.json();
  if (response.status === 409 && data.detail?.code === 'personal_data') {
    if (!await confirmPersonalData(data.detail.categories, 'email')) return null;
    response = await post({ ...payload, personal_data_confirmed: true });
    data = await response.json();
  }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message ?? fallback);
  return data;
}

function saveBlob(blob: Blob, filename: string, click: () => void, anchor: HTMLAnchorElement) {
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function generatedFileReview(blob: Blob, filename: string, request: typeof fetch): Promise<{ categories: string[]; blocked: string[] }> {
  try {
    const response = await request(SCAN_URL, {
      method: 'POST', body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(filename) },
    });
    if (!response.ok) return { categories: [UNCHECKED], blocked: [] };
    return await response.json();
  } catch {
    return { categories: [UNCHECKED], blocked: [] };
  }
}

let installed = false;

/** Review every file download, including ones started by a plain link or generated in the browser. */
export function installPersonalDataReview() {
  if (installed) return;
  installed = true;
  const request = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const retry = input instanceof Request ? input.clone() : input;
    const response = await request(input, init);
    const review = response.headers.get(REVIEW_HEADER);
    if (response.status === 403 && review === 'blocked') {
      await notifyBlocked((await response.clone().json()).detail.categories);
      return response;
    }
    if (response.status !== 409 || review !== 'download') return response;
    const { detail } = await response.clone().json();
    if (!await confirmPersonalData(detail.categories, detail.code === 'personal_data_share' ? 'share' : 'file')) return response;
    const headers = new Headers(init?.headers ?? (retry instanceof Request ? retry.headers : undefined));
    headers.set(CONFIRM_HEADER, '1');
    return request(retry, { ...init, headers });
  };

  const nativeClick = HTMLAnchorElement.prototype.click;
  const reviewed = new WeakSet<HTMLAnchorElement>();
  const start = async (anchor: HTMLAnchorElement) => {
    const filename = anchor.download;
    const click = () => { reviewed.add(anchor); nativeClick.call(anchor); };
    if (anchor.href.startsWith('blob:') || anchor.href.startsWith('data:')) {
      const blob = await (await request(anchor.href)).blob();
      const { categories, blocked } = await generatedFileReview(blob, filename, request);
      if (blocked?.length) { await notifyBlocked(blocked); return; }
      if (categories.length && !await confirmPersonalData(categories, 'file')) return;
      saveBlob(blob, filename, click, anchor);
      return;
    }
    const response = await window.fetch(anchor.href, { credentials: 'same-origin' });
    if (response.ok) saveBlob(await response.blob(), filename, click, anchor);
  };
  const needsReview = (anchor: HTMLAnchorElement) => {
    if (reviewed.delete(anchor) || !anchor.hasAttribute('download') || !anchor.href) return false;
    if (anchor.href.startsWith('blob:') || anchor.href.startsWith('data:')) return true;
    return new URL(anchor.href, location.href).origin === location.origin;
  };
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (needsReview(this)) void start(this);
    else nativeClick.call(this);
  };
  document.addEventListener('click', event => {
    const anchor = (event.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
    if (anchor && needsReview(anchor)) {
      event.preventDefault();
      void start(anchor);
    }
  }, true);
}
