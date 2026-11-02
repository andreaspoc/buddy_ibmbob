/** Distinguish pointer entry from Tab navigation for the chat composer's focus. */
export function trackInputModality() {
  const root = document.documentElement;
  const previous = root.dataset.inputModality;
  root.dataset.inputModality = 'keyboard';
  const pointer = () => { root.dataset.inputModality = 'pointer'; };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'Tab') root.dataset.inputModality = 'keyboard';
  };
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('keydown', keyboard, true);
  return () => {
    document.removeEventListener('pointerdown', pointer, true);
    document.removeEventListener('keydown', keyboard, true);
    if (previous === undefined) delete root.dataset.inputModality;
    else root.dataset.inputModality = previous;
  };
}
