/** Purple-to-theme colour mapping shared by the CSS build step and the runtime. */
export const THEME_ANCHOR = { h: 265, s: 65.4, l: 46.5 };
const DARK_TONE_LIMIT = 60;

export interface Hsl { h: number; s: number; l: number }

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
  const l = (max + min) / 2;
  if (!delta) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  const sector = max === red ? ((green - blue) / delta + 6) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return { h: sector * 60, s: s * 100, l: l * 100 };
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const body = hex.replace(/^#/, '');
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(body)) return null;
  const full = body.length <= 4 ? [...body].map(char => char + char).join('') : body;
  return [0, 2, 4].map(start => Number.parseInt(full.slice(start, start + 2), 16)) as [number, number, number];
}

/** True for the violet family used as the product's accent colour. */
export function isThemePurple({ h, s }: Hsl): boolean {
  return h >= 245 && h <= 305 && s > 12;
}

const round = (value: number) => Math.round(value * 100) / 100;

function themedHsl(color: Hsl, alpha?: string): string {
  const light = color.l < DARK_TONE_LIMIT
    ? `calc(${round(color.l)}% * var(--theme-l, 1))`
    : `${round(color.l)}%`;
  return `hsl(calc(${round(color.h)}deg + var(--theme-h, 0deg)) calc(${round(color.s)}% * var(--theme-s, 1)) ${light}${alpha ? ` / ${alpha}` : ''})`;
}

const COLOR_TOKEN = /url\([^)]*\)|#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b|rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+([\d.]+%?))?\s*\)/gi;

/** Rewrite violet colours in a CSS value so custom properties can re-tint them. */
export function themeCssValue(value: string): string {
  return value.replace(COLOR_TOKEN, (token, r?: string, g?: string, b?: string, alpha?: string) => {
    if (/^url/i.test(token)) return token;
    if (r !== undefined) {
      const hsl = rgbToHsl(Number(r), Number(g), Number(b));
      return isThemePurple(hsl) ? themedHsl(hsl, alpha) : token;
    }
    const rgb = hexToRgb(token);
    if (!rgb) return token;
    const hsl = rgbToHsl(...rgb);
    if (!isThemePurple(hsl)) return token;
    const body = token.slice(1);
    const alphaHex = body.length === 8 ? body.slice(6) : body.length === 4 ? body[3] + body[3] : '';
    return themedHsl(hsl, alphaHex ? String(round(Number.parseInt(alphaHex, 16) / 255)) : undefined);
  });
}

/** PostCSS plugin: source CSS stays authored in purple; the build output is themeable. */
export function themeColorPostcss() {
  return {
    postcssPlugin: 'buddy-theme-color',
    Declaration(decl: { value: string }) {
      const next = themeCssValue(decl.value);
      if (next !== decl.value) decl.value = next;
    },
  };
}
themeColorPostcss.postcss = true;
