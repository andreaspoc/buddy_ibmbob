import { animateInterface, prefersReducedMotion, uiMotion } from './motion';

const skill = '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>';
const collaboration = '<path d="m7 9 4-3m2 0 4 3M7 15l4 3m2 0 4-3"/><circle cx="12" cy="4" r="2.5"/><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><circle cx="12" cy="20" r="2.5"/>';

/** A small, stationary skills-to-collaboration cue; never clone the conversation. */
export function transitionConversationMode(surface: HTMLElement | null, toAgents: boolean) {
  if (!surface || prefersReducedMotion()) return { finished: Promise.resolve(), cancel() {} };
  const indicator = document.createElement('div');
  indicator.className = 'conversation-mode-transition';
  indicator.dataset.modeTransition = toAgents ? 'agents' : 'skills';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.inert = true;
  const symbols = [toAgents ? skill : collaboration, toAgents ? collaboration : skill].map(markup => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.25');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = markup;
    indicator.append(svg);
    return svg;
  });
  (surface.parentElement || surface).append(indicator);
  const duration = uiMotion.modeSwitch * 2;
  const outgoing = animateInterface(symbols[0], [
    { opacity: 1, transform: 'scale(1)', offset: 0 },
    { opacity: 1, transform: 'scale(1)', offset: .2 },
    { opacity: 0, transform: 'scale(.9)', offset: .65 },
    { opacity: 0, transform: 'scale(.9)', offset: 1 },
  ], { duration, easing: uiMotion.easing, fill: 'both' });
  const incoming = animateInterface(symbols[1], [
    { opacity: 0, transform: 'scale(.9)', offset: 0 },
    { opacity: 0, transform: 'scale(.9)', offset: .35 },
    { opacity: 1, transform: 'scale(1)', offset: .8 },
    { opacity: 1, transform: 'scale(1)', offset: 1 },
  ], { duration, easing: uiMotion.easing, fill: 'both' });
  const cancel = () => { outgoing.cancel(); incoming.cancel(); indicator.remove(); };
  const finished = Promise.all([outgoing.finished, incoming.finished]).then(() => {}).finally(cancel);
  return { finished, cancel };
}
