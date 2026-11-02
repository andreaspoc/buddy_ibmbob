// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncPresentationDocument } from '../../src/lib/presentationDom';

describe('presentationDom syncPresentationDocument', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = `
      <head>
        <title>Original Presentation</title>
        <style id="bob-nav-fix-style">.nav { color: red; }</style>
      </head>
      <body>
        <div id="slide-1" class="slide active">
          <h1>Welcome</h1>
          <p>Initial content</p>
          <canvas width="400" height="300" style="background: white;"></canvas>
          <script id="keep-me">console.log('original script');</script>
        </div>
      </body>
    `;
  });

  it('patches attributes, text nodes, and keeps canvas dimensions', () => {
    const updatedHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Updated Presentation</title>
        </head>
        <body>
          <div id="slide-1" class="slide updated">
            <h1>Welcome to Cloud Architecture</h1>
            <p>Updated content</p>
            <canvas width="500" height="400"></canvas>
          </div>
        </body>
      </html>
    `;

    syncPresentationDocument(document, updatedHtml);

    expect(document.title).toBe('Updated Presentation');
    const slide = document.getElementById('slide-1');
    expect(slide?.className).toBe('slide updated');
    expect(document.querySelector('h1')?.textContent).toBe('Welcome to Cloud Architecture');
    expect(document.querySelector('p')?.textContent).toBe('Updated content');
    // Canvas style attribute preserved
    expect(document.querySelector('canvas')?.getAttribute('style')).toBe('background: white;');
    // Runtime style helper preserved
    expect(document.getElementById('bob-nav-fix-style')).not.toBeNull();
  });

  it('executes newly introduced scripts and cleans up unmatched nodes', async () => {
    const htmlWithNewScript = `
      <html>
        <body>
          <div id="slide-2">
            <h2>New Slide</h2>
            <script>window.__testedNewScript = true;</script>
          </div>
        </body>
      </html>
    `;

    syncPresentationDocument(document, htmlWithNewScript);

    const slide2 = document.getElementById('slide-2');
    expect(slide2).not.toBeNull();
    expect(document.getElementById('slide-1')).toBeNull(); // removed old slide

    // Wait for script queue promise
    const runtime = document as Document & { bobScriptQueue?: Promise<void> };
    await runtime.bobScriptQueue;
    expect(document.querySelector('h2')?.textContent).toBe('New Slide');
  });

  it('patches comment nodes and retains unchanged elements', () => {
    const htmlWithComment = `
      <html>
        <body>
          <!-- new comment -->
          <div id="slide-1" class="slide active">
            <h1>Welcome</h1>
            <p>Initial content</p>
          </div>
        </body>
      </html>
    `;

    syncPresentationDocument(document, htmlWithComment);
    expect(document.getElementById('slide-1')).not.toBeNull();
  });

  it('preserves scroll position and window coordinates', () => {
    const scrollEl = document.createElement('div');
    scrollEl.style.overflow = 'auto';
    scrollEl.id = 'scroll-box';
    Object.defineProperty(scrollEl, 'scrollTop', { value: 50, writable: true });
    Object.defineProperty(scrollEl, 'scrollLeft', { value: 20, writable: true });
    document.body.appendChild(scrollEl);

    const winScrollTo = vi.fn();
    window.scrollTo = winScrollTo;
    Object.defineProperty(window, 'scrollX', { value: 10, writable: true });
    Object.defineProperty(window, 'scrollY', { value: 30, writable: true });

    const newHtml = `
      <html>
        <body>
          <div id="scroll-box" style="overflow: auto;">
            <span>Long text</span>
          </div>
        </body>
      </html>
    `;

    syncPresentationDocument(document, newHtml);

    const newBox = document.getElementById('scroll-box');
    expect(newBox).not.toBeNull();
  });
});
