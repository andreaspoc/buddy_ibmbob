/** Batch network deltas once per paint, with a bounded catch-up window. */
export function createTextStream(
  append: (text: string) => void,
  frame: (callback: () => void) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
  immediate: () => boolean = () => document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches,
  now: () => number = () => performance.now(),
) {
  let pending = '';
  let scheduled: number | null = null;
  let started = 0;
  let previousPaint = 0;
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let finishDrain: (() => void) | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (scheduled !== null) cancel(scheduled);
    scheduled = null;
    pending = '';
    draining = false;
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    drainTimer = undefined;
    const resolve = finishDrain;
    finishDrain = undefined;
    drainPromise = undefined;
    resolve?.();
  };
  const flush = () => {
    const text = pending;
    clear();
    if (text) append(text);
  };
  const tick = () => {
    scheduled = null;
    if (immediate()) { flush(); return; }
    const time = now();
    const remaining = Math.max(0, 240 - (time - started));
    const elapsed = Math.max(1, time - previousPaint);
    previousPaint = time;
    let take = remaining <= elapsed || draining ? pending.length : Math.min(pending.length, Math.max(4, Math.ceil(pending.length * elapsed / remaining)));
    // Keep a trailing high surrogate for the next transport chunk. Never paint
    // an unmatched half merely because it arrived in a separate network event.
    const code = pending.charCodeAt(take - 1);
    if (code >= 0xd800 && code <= 0xdbff) take += take < pending.length ? 1 : -1;
    const text = pending.slice(0, take);
    pending = pending.slice(take);
    if (text) append(text);
    if (pending) scheduled = frame(tick);
    else clear();
  };
  return {
    push(text: string) {
      if (!text) return;
      if (!pending) started = previousPaint = now();
      pending += text;
      // Flush old and new text together to preserve order if visibility or the
      // reduced-motion preference changes between incoming chunks.
      if (immediate()) { flush(); return; }
      if (scheduled === null) scheduled = frame(tick);
    },
    drain() {
      if (immediate() || !pending) { flush(); return Promise.resolve(); }
      if (drainPromise) return drainPromise;
      draining = true;
      drainPromise = new Promise<void>(resolve => {
        finishDrain = resolve;
        // Background tabs may suspend frames after drain has already started.
        drainTimer = setTimeout(flush, 150);
      });
      return drainPromise;
    },
    flush,
    clear,
  };
}
