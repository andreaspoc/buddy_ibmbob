import { useSyncExternalStore } from 'react';
const desktopQuery = '(min-width: 1101px)';
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
export function useDesktopWorkspace() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(desktopQuery).matches, () => true);
}
