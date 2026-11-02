import { themeColor } from './appearance';
import { animateInterface, uiMotion } from './motion';
/** Shared paper fold and flight used by notes and conversation mode changes. */
export const PAPER_FLIGHT_DURATION = uiMotion.transfer;
export const PAPER_FLIGHT_EASING = uiMotion.easing;

export async function flyNoteToNotes(card: HTMLElement | null, flights: Map<HTMLElement, Animation>) {
    const target = [...document.querySelectorAll<HTMLElement>('.topbar-pinned-reminders,.topbar-notifications,[data-notes-inbox-target],.workspace-notes-tab')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    return flyCardToTarget(card, flights, target);
}

export async function flyCardToTarget(card: HTMLElement | null, flights: Map<HTMLElement, Animation>, target?: HTMLElement | null, visual: 'plane' | 'team' | 'skills' = 'plane') {
    if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = card.getBoundingClientRect();
    const to = target?.getBoundingClientRect();
    const destination = to && to.width > 0 && to.height > 0 ? { x: to.left + to.width / 2, y: to.top + to.height / 2 } : { x: innerWidth - 36, y: 30 };
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const dx = (destination.x - from.left - from.width / 2) / scale;
    const dy = (destination.y - from.top - from.height / 2) / scale;
    const ghost = card.cloneNode(true) as HTMLElement;
    ghost.classList.add('sticky-note', 'sticky-note-flight');
    ghost.removeAttribute('id');
    for (const child of ghost.querySelectorAll('[id],[autofocus],[aria-live]')) {
      child.removeAttribute('id'); child.removeAttribute('autofocus'); child.removeAttribute('aria-live');
    }
    ghost.setAttribute('aria-hidden', 'true');
    ghost.dataset.motionGhost = '';
    ghost.dataset.flightVisual = visual;
    ghost.inert = true;
    Object.assign(ghost.style, { left: `${from.left / scale}px`, top: `${from.top / scale}px`, width: `${from.width / scale}px`, height: `${from.height / scale}px` });
    document.body.appendChild(ghost);
    // Let the paper fold visibly before the plane takes off.
    for (const child of Array.from(ghost.children)) {
      animateInterface(child, [{ opacity: 1 }, { opacity: 0 }], { duration: uiMotion.fast, fill: 'forwards' });
    }
    const plane = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    plane.setAttribute('viewBox', '0 0 120 100');
    plane.classList.add('sticky-note-plane');
    plane.innerHTML = '<path d="M5 8 115 50 5 92 29 50Z" fill="var(--paper)" stroke="var(--paper-edge)" stroke-width="1.5" stroke-linejoin="round"/><path d="m5 8 110 42H29Z" fill="white" fill-opacity=".48"/><path d="M29 50H115L39 64Z" fill="var(--paper-deep)"/><path d="m29 50 10 14-1-14" fill="#a48b66" fill-opacity=".35"/><path d="M29 50H115" stroke="var(--paper-edge)" stroke-width="1.2"/>';
    if (visual !== 'plane') {
      plane.setAttribute('viewBox', '0 0 320 240');
      plane.classList.add('conversation-flight-symbol');
      plane.innerHTML = (visual === 'team'
        ? '<rect x="10" y="10" width="300" height="220" rx="36" fill="#f3ecff" stroke="#d7c4ed" stroke-width="2"/><circle cx="160" cy="63" r="27" fill="#6929c4"/><path d="M109 150v-25a51 51 0 0 1 102 0v25Z" fill="#6929c4"/><circle cx="76" cy="105" r="23" fill="#0f62fe"/><path d="M31 186v-24a45 45 0 0 1 90 0v24Z" fill="#0f62fe"/><circle cx="244" cy="105" r="23" fill="#009d9a"/><path d="M199 186v-24a45 45 0 0 1 90 0v24Z" fill="#009d9a"/><path d="M132 190h56M145 207h30" stroke="#a56eff" stroke-width="7" stroke-linecap="round"/>'
        : '<rect x="10" y="10" width="300" height="220" rx="36" fill="#f3ecff" stroke="#d7c4ed" stroke-width="2"/><rect x="40" y="55" width="76" height="125" rx="14" fill="#0f62fe" transform="rotate(-10 78 118)"/><rect x="204" y="55" width="76" height="125" rx="14" fill="#009d9a" transform="rotate(10 242 118)"/><rect x="115" y="40" width="90" height="150" rx="14" fill="#6929c4"/><path d="m160 74 7 19 20 1-16 13 5 20-16-12-16 12 5-20-16-13 20-1Z" fill="white"/><path d="M139 151h42M139 165h28" stroke="white" stroke-width="6" stroke-linecap="round"/>').replace(/#[\da-f]{6}\b/gi, color => themeColor(color));
    }
    ghost.appendChild(plane);
    animateInterface(plane, [{ opacity: 0, transform: 'scale(.7) rotateY(-70deg)' }, { opacity: 1, transform: 'scale(1) rotateY(0deg)' }], { delay: uiMotion.fast, duration: uiMotion.fast, fill: 'both', easing: uiMotion.entrance });
    const heading = visual === 'plane' ? Math.atan2(dy, dx) * 180 / Math.PI : 0;
    const rectangle = 'polygon(0% 0%, 100% 0%, 100% 50%, 100% 100%, 0% 100%)';
    const folded = visual === 'plane' ? 'polygon(4% 8%, 96% 50%, 32% 50%, 4% 92%, 24% 50%)' : rectangle;
    const animation = animateInterface(ghost, [
      { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1, clipPath: rectangle },
      { transform: 'translate(0, -24px) rotate(-8deg) scale(.65)', opacity: 1, clipPath: rectangle, offset: .17 },
      { transform: 'translate(0, -38px) rotate(-12deg) scale(.36)', opacity: 1, clipPath: folded, offset: .34, background: 'transparent', borderColor: 'transparent', boxShadow: 'none' },
      { transform: `translate(${dx * .22}px, ${dy * .3 - 50}px) rotate(${heading - 12}deg) scale(.34)`, opacity: 1, clipPath: rectangle, offset: .57, background: 'transparent', borderColor: 'transparent', boxShadow: 'none' },
      { transform: `translate(${dx * .73}px, ${dy * .82 - 24}px) rotate(${heading + 5}deg) scale(.23)`, opacity: 1, clipPath: rectangle, offset: .83, background: 'transparent', borderColor: 'transparent', boxShadow: 'none' },
      { transform: `translate(${dx}px, ${dy}px) rotate(${heading}deg) scale(.06)`, opacity: 0, clipPath: rectangle, background: 'transparent', borderColor: 'transparent', boxShadow: 'none' }
    ], { duration: visual === 'plane' ? PAPER_FLIGHT_DURATION : uiMotion.modeSwitch, easing: PAPER_FLIGHT_EASING, fill: 'forwards' });
    flights.set(ghost, animation);
    card.classList.add('is-moving-to-notes');
    try {
      await animation.finished;
      if (target?.isConnected) animateInterface(target, [{ transform: 'scale(1)' }, { transform: 'scale(1.02)', background: themeColor('#dbc1f5') }, { transform: 'scale(1)' }], { duration: uiMotion.fast, easing: uiMotion.entrance });
    } catch { /* Unmount cancels the decorative flight. */ }
    finally { flights.delete(ghost); ghost.remove(); card.classList.remove('is-moving-to-notes'); }
  }
