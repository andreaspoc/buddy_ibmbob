import { durationFast02, durationModerate01, durationModerate02, durationSlow01, durationSlow02, easings } from '@carbon/motion';

/** Productive motion shared by app chrome; documents own their presentation styles. */
export const uiMotion = {
  fast: Number.parseFloat(durationFast02),
  standard: Number.parseFloat(durationModerate01),
  enter: Number.parseFloat(durationModerate02),
  transfer: Number.parseFloat(durationSlow01),
  modeSwitch: Number.parseFloat(durationSlow02),
  chartEnter: Number.parseFloat(durationSlow02) * 2,
  chartUpdate: Number.parseFloat(durationSlow02),
  easing: easings.standard.productive,
  entrance: easings.entrance.productive,
  exit: easings.exit.productive,
};
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const scrollBehavior = (): ScrollBehavior => prefersReducedMotion() ? 'instant' : 'smooth';

/** Finish an in-flight interaction when the OS preference changes, including cleanup. */
export function animateInterface(element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const animation = element.animate(frames, preference.matches ? { ...options, delay: 0, duration: 0 } : options);
  const finish = () => { if (preference.matches && animation.playState !== 'idle') animation.finish(); };
  preference.addEventListener('change', finish);
  void animation.finished.catch(() => {}).finally(() => preference.removeEventListener('change', finish));
  return animation;
}
