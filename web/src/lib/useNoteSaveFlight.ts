import { useCallback, useEffect, useRef } from 'react';
import { flyNoteToNotes } from './noteFlight';

export type NoteSavedEvent = { note_id?: number; note_title?: string; note_color?: string; note_collection?: string };

/** Server-confirmed conversational saves share the manual Save animation. */
export function useNoteSaveFlight() {
  const flights = useRef(new Map<HTMLElement, Animation>());
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const queued = useRef(new Set<HTMLElement>());
  const seeds = useRef(new Set<HTMLElement>());

  useEffect(() => {
    alive.current = true;
    const active = flights.current,
      pending = seeds.current,
      waiting = queued.current;
    return () => {
      alive.current = false;
      for (const card of waiting) card.removeAttribute('data-note-flight-queued');
      waiting.clear();
      for (const [ghost, animation] of active) {
        animation.cancel();
        ghost.remove();
      }
      active.clear();
      for (const seed of pending) seed.remove();
      pending.clear();
    };
  }, []);

  return useCallback((event: NoteSavedEvent) => {
    if (!Number.isInteger(event.note_id) || typeof event.note_title !== 'string' || !event.note_title.trim()) {
      return Promise.resolve();
    }

    const targetTitle = (event.note_title || '').trim().toLowerCase();
    const allCards = [...document.querySelectorAll<HTMLElement>('[data-sticky-notes] .sticky-note')];

    // Priority 1: Exact title match among unqueued, unsaved cards
    let candidate = allCards.find(
      card =>
        (card.dataset.noteTitle || '').trim().toLowerCase() === targetTitle &&
        !card.hasAttribute('data-note-flight-queued') &&
        !card.classList.contains('is-saved')
    );

    // Priority 2: Substring or partial match
    if (!candidate && targetTitle) {
      candidate = allCards.find(card => {
        const title = (card.dataset.noteTitle || '').trim().toLowerCase();
        return (
          (title.includes(targetTitle) || targetTitle.includes(title)) &&
          !card.hasAttribute('data-note-flight-queued') &&
          !card.classList.contains('is-saved')
        );
      });
    }

    // Priority 3: Match title even if previously matched
    if (!candidate && targetTitle) {
      const titleMatches = allCards.filter(
        card => (card.dataset.noteTitle || '').trim().toLowerCase() === targetTitle
      );
      if (titleMatches.length > 0) {
        candidate = titleMatches[titleMatches.length - 1];
      }
    }

    // Priority 4: Last unsaved sticky note card in DOM
    if (!candidate) {
      const unsaved = allCards.filter(
        card => !card.hasAttribute('data-note-flight-queued') && !card.classList.contains('is-saved')
      );
      if (unsaved.length > 0) {
        candidate = unsaved[unsaved.length - 1];
      }
    }

    if (candidate) {
      candidate.setAttribute('data-note-flight-queued', '');
      queued.current.add(candidate);
    }

    const original = candidate;

    const run = async () => {
      let seed: HTMLElement | undefined;
      try {
        if (!alive.current) return;
        let card = original?.isConnected ? original : undefined;
        if (card) {
          // Tell ChatView to pause locking scroll to bottom so the user can autoscroll up to the note
          window.dispatchEvent(new CustomEvent('buddy-note-flight-scroll'));

          const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

          // Check if card is currently visible within comfortable viewport boundaries
          const rect = card.getBoundingClientRect();
          const inView = rect.top >= 80 && rect.bottom <= (window.innerHeight - 80);

          if (!inView) {
            // Give visual focus to the card as it prepares to send
            card.classList.add('is-preparing-to-send');

            // Scroll the card smoothly into center view
            card.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'instant' : 'smooth' });

            if (!reduced) {
              // Wait for the smooth scroll to finish and settle
              await new Promise<void>(resolve => {
                const started = performance.now();
                let previous = card!.getBoundingClientRect().top;
                let stable = 0;
                const checkFrame = () => {
                  const top = card!.getBoundingClientRect().top;
                  if (Math.abs(top - previous) < 1) {
                    stable++;
                  } else {
                    stable = 0;
                  }
                  previous = top;
                  if (!alive.current || stable >= 3 || performance.now() - started > 400 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    resolve();
                  } else {
                    requestAnimationFrame(checkFrame);
                  }
                };
                requestAnimationFrame(checkFrame);
              });


            }
          }
        } else {
          // A save with no original draft still receives decorative feedback.
          seed = document.createElement('article');
          seed.className = 'sticky-note sticky-note-save-seed';
          seed.setAttribute('aria-hidden', 'true');
          seed.inert = true;
          if (['butter', 'rose', 'lavender', 'mint', 'sky'].includes(event.note_color || '')) {
            seed.dataset.noteColor = event.note_color;
          }
          const title = document.createElement('h3');
          title.textContent = event.note_title || '';
          seed.append(title);
          document.body.append(seed);
          seeds.current.add(seed);
          card = seed;
        }

        if (alive.current) {
          await flyNoteToNotes(card, flights.current);
        }
      } catch {
        /* Animation failure must never interrupt a successful save. */
      } finally {
        if (original) {
          original.classList.remove('is-preparing-to-send');
          queued.current.delete(original);
          original.removeAttribute('data-note-flight-queued');
          if (alive.current) {
            window.dispatchEvent(
              new CustomEvent('buddy-note-moved', {
                detail: {
                  sessionId: original.dataset.noteSession,
                  messageId: original.dataset.noteMessage,
                  key: original.dataset.noteKey,
                },
              })
            );
          }
        }
        if (seed) {
          seeds.current.delete(seed);
          seed.remove();
        }
        if (alive.current) {
          window.dispatchEvent(new Event('buddy-notes-changed'));
        }
      }
    };

    queue.current = queue.current.then(run, run);
    return queue.current;
  }, []);
}
