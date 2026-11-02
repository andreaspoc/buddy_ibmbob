import { animateInterface, uiMotion } from './motion';
import { useCallback, useEffect, useRef } from 'react';

/** A confirmed copy travels to the library; the source stays in place. */
export function useTransferFeedback() {
  const active = useRef(new Map<HTMLElement, Animation>());
  useEffect(() => () => {
    for (const [ghost, animation] of active.current) { animation.cancel(); ghost.remove(); }
    active.current.clear();
  }, []);
  return useCallback((source: HTMLElement | null, label: string, destination: 'office' | 'notes') => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !source?.isConnected) return;
    const target = document.querySelector<HTMLElement>(`[data-workspace-destination="${destination}"]`)
      || document.querySelector<HTMLElement>('.workspace-notes-tab');
    const from = source.getBoundingClientRect(), to = target?.getBoundingClientRect();
    if (!from.width || !from.height) return;
    const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const ghost = document.createElement('div');
    ghost.className = 'workspace-transfer-flight'; ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span'); icon.textContent = destination === 'office' ? '▤' : '▱';
    const title = document.createElement('strong'); title.textContent = label;
    ghost.append(icon, title);
    Object.assign(ghost.style, { left: `${from.left / scale}px`, top: `${from.top / scale}px`, width: `${Math.min(from.width / scale, 250)}px` });
    document.body.append(ghost);
    const dx = ((to?.width ? to.left + to.width / 2 : innerWidth - 40) - from.left - Math.min(from.width, 250 * scale) / 2) / scale;
    const dy = ((to?.height ? to.top + to.height / 2 : 30) - from.top - 25 * scale) / scale;
    const animation = animateInterface(ghost, [
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: 'translate(0,-20px) scale(1.04)', opacity: 1, offset: .2 },
      { transform: `translate(${dx * .65}px,${dy * .65 - 24}px) rotate(-8deg) scale(.6)`, opacity: 1, offset: .7 },
      { transform: `translate(${dx}px,${dy}px) rotate(0deg) scale(.12)`, opacity: 0 },
    ], { duration: uiMotion.transfer, easing: uiMotion.easing, fill: 'forwards' });
    active.current.set(ghost, animation);
    void animation.finished.then(() => {
      if (target?.isConnected) animateInterface(target, [{ scale: '1' }, { scale: '1.02' }, { scale: '1' }], { duration: uiMotion.fast });
    }).catch(() => {}).finally(() => { active.current.delete(ghost); ghost.remove(); });
  }, []);
}
