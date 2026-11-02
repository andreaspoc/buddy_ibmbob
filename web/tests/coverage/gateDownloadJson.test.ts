// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error plain JS module outside web tsconfig
import { downloadJson } from '../../../decisions-buddy/src/lib/downloadJson.js';

describe('downloadJson', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('downloads pretty JSON and revokes the temporary URL after a minute', async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:synthetic'; }) as any;
    URL.revokeObjectURL = vi.fn();
    const clicked: { download: string; href: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href, attached: this.isConnected });
    });

    downloadJson({ a: 1 }, 'decision.json');

    expect(clicked).toEqual([{ download: 'decision.json', href: 'blob:synthetic', attached: true }]);
    expect(document.querySelector('a')).toBeNull();
    expect(blobs[0].type).toBe('application/json');
    expect(await blobs[0].text()).toBe('{\n  "a": 1\n}');
    vi.advanceTimersByTime(59_999);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
  });
});
