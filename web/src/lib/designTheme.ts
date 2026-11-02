import { applyDesignThemeValue, readDesignTheme, startAppearance } from './appearance';

/** Restore the saved workspace theme, accent colour and assistant name. */
export function applyDesignTheme() {
  applyDesignThemeValue(readDesignTheme());
  startAppearance();
}
