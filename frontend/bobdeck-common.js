// Shared rendering primitives for the legacy and current presentation UI.
export const W = 13.333;

export const H = 7.5;

export const S = 100;

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function normalizeHex(value, fallback = '111111') {
  let v = value;
  if (v && typeof v === 'object') {
    v = v.color ?? v.hex ?? v.value ?? v.rgb ?? v.fill ?? v.foreground ?? v.background;
  }
  if (typeof v !== 'string') return fallback.replace(/^#/, '').toUpperCase();
  let s = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map(c => c + c).join('');
  if (/^[0-9a-f]{8}$/i.test(s)) s = s.slice(0, 6);
  if (/^[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    return rgb.slice(1, 4).map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return fallback.replace(/^#/, '').toUpperCase();
}

export function toCssColor(value, fallback = '#111111') {
  const hex = normalizeHex(value, fallback);
  return '#' + hex;
}

export const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);

export const xOf = e => num(e.x, 0);

export const yOf = e => num(e.y, 0);

export const wOf = e => num(e.w ?? e.width, 1);

export const hOf = e => num(e.h ?? e.height, 1);

export const textOf = e => String(e.text ?? e.content ?? '');

export const styleOf = e => (e?.style && typeof e.style === 'object' ? e.style : {});

export const fontSizeOf = e => num(e.fontSize ?? styleOf(e).fontSize, 24);

export const boldOf = e => Boolean(e.bold ?? ['bold', '700', '800', '900'].includes(String(styleOf(e).fontWeight).toLowerCase()));

export const alignOf = e => e.align ?? styleOf(e).align ?? 'left';

export const colorOf = e => e.color ?? styleOf(e).color;

export const fillOf = e => e.fill ?? styleOf(e).fill;

export const strokeOf = e => e.stroke ?? e.border?.color ?? styleOf(e).stroke;

export const lineWidthOf = e => num(e.lineWidth ?? e.border?.width ?? styleOf(e).lineWidth, 1);

export const shapeOf = e => String(e.shape ?? 'rectangle');

export function slideBackground(s, theme) {
  return s?.background?.color ?? s?.background ?? theme?.colors?.background ?? theme?.background ?? 'FFFFFF';
}

export function themeForeground(theme) {
  return theme?.colors?.text ?? theme?.foreground ?? '1A0A2E';
}

export function themeAccent(theme) {
  return theme?.colors?.accent ?? theme?.accent ?? '5B1F8A';
}

export function chartSeries(e) {
  if (Array.isArray(e?.series) && e.series.length) {
    const categories = Array.isArray(e.categories) ? e.categories.map(String) : [];
    return e.series.map((s, si) => ({
      name: String(s.name ?? `Series ${si + 1}`),
      labels: (Array.isArray(s.labels) ? s.labels : categories).map(String),
      values: (Array.isArray(s.values) ? s.values : []).map(v => num(v, 0)),
      color: s.color,
    }));
  }
  const data = Array.isArray(e?.data) ? e.data : [];
  return [{
    name: String(e?.name ?? 'Series'),
    labels: data.map(d => String(d.label ?? d.category ?? '')),
    values: data.map(d => num(d.value, 0)),
    color: e?.color,
  }];
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  return el;
}

export function renderShapeSvg(e) {
  const x = xOf(e) * S;
  const y = yOf(e) * S;
  const w = wOf(e) * S;
  const h = hOf(e) * S;
  const fill = toCssColor(fillOf(e), '#F5EEFF');
  const stroke = toCssColor(strokeOf(e) ?? fillOf(e), '#5B1F8A');
  const sw = lineWidthOf(e);
  const sh = shapeOf(e);

  if (['ellipse', 'circle'].includes(sh)) {
    return svgEl('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, fill, stroke, 'stroke-width': sw });
  }
  if (sh === 'triangle') {
    return svgEl('polygon', { points: `${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`, fill, stroke, 'stroke-width': sw });
  }
  if (sh === 'diamond') {
    return svgEl('polygon', { points: `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`, fill, stroke, 'stroke-width': sw });
  }
  if (sh === 'chevron') {
    return svgEl('polygon', { points: `${x},${y} ${x + w * 0.72},${y} ${x + w},${y + h / 2} ${x + w * 0.72},${y + h} ${x},${y + h} ${x + w * 0.28},${y + h / 2}`, fill, stroke, 'stroke-width': sw });
  }
  if (sh === 'hexagon') {
    return svgEl('polygon', { points: `${x + w * 0.25},${y} ${x + w * 0.75},${y} ${x + w},${y + h / 2} ${x + w * 0.75},${y + h} ${x + w * 0.25},${y + h} ${x},${y + h / 2}`, fill, stroke, 'stroke-width': sw });
  }
  const rx = (sh === 'roundedRectangle' || sh === 'roundRect') ? Math.min(20, h * 0.18) : num(e.radius, 0) * S;
  return svgEl('rect', { x, y, width: w, height: h, rx, fill, stroke, 'stroke-width': sw });
}

export function isEmojiOrIconBadge(str) {
  if (!str) return false;
  const trimmed = str.trim();
  // Typical icon badges are 1-2 emoji/symbol glyphs (length <= 8 bytes)
  if (trimmed.length === 0 || trimmed.length > 8) return false;
  const emojiPattern = /[\p{Extended_Pictographic}\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/u;
  return emojiPattern.test(trimmed);
}

export function renderEmojiToDataUrl(emoji, hexColor = 'FFFFFF', size = 256) {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, size, size);
    ctx.font = `${Math.round(size * 0.72)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", "Segoe UI Symbol", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#' + normalizeHex(hexColor, 'FFFFFF');
    ctx.fillText(emoji.trim(), size / 2, size / 2 + size * 0.04);
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('Could not render emoji to data URL', err);
    return null;
  }
}

export function renderCartesianChart({e, series, type, ix, iy, iw, ih, g, palette}) {
  const count = Math.max(1, ...series.map(s => s.values.length));
  const max = Math.max(1, ...series.flatMap(s => s.values.map(v => Math.abs(v))));

  // Base axis line
  g.append(svgEl('line', { x1: ix, y1: iy + ih, x2: ix + iw, y2: iy + ih, stroke: '#D9CBE6' }));

  if (type === 'line') {
    series.forEach((sr, si) => {
      const pts = sr.values.map((v, i) => `${ix + (count === 1 ? iw / 2 : (i * iw) / (count - 1))},${iy + ih - (v / max) * ih * 0.88}`).join(' ');
      const strokeColor = toCssColor(sr.color ?? palette[si % palette.length], '#5B1F8A');
      g.append(svgEl('polyline', { points: pts, fill: 'none', stroke: strokeColor, 'stroke-width': 3 }));
      sr.values.forEach((v, i) => {
        g.append(svgEl('circle', {
          cx: ix + (count === 1 ? iw / 2 : (i * iw) / (count - 1)),
          cy: iy + ih - (v / max) * ih * 0.88,
          r: 4,
          fill: strokeColor,
        }));
      });
    });
  } else {
    const groupW = iw / count;
    const barW = (groupW * 0.72) / Math.max(1, series.length);
    series.forEach((sr, si) => {
      sr.values.forEach((v, i) => {
        const bh = (v / max) * ih * 0.88;
        g.append(svgEl('rect', {
          x: ix + i * groupW + groupW * 0.14 + si * barW,
          y: iy + ih - bh,
          width: Math.max(2, barW - 2),
          height: bh,
          rx: 2,
          fill: toCssColor(sr.color ?? palette[si % palette.length], '#5B1F8A'),
        }));
      });
    });
  }

  // Category labels
  const labels = series[0]?.labels ?? [];
  labels.forEach((lab, i) => {
    if (!lab) return;
    const t = svgEl('text', {
      x: ix + i * (iw / count) + (iw / count) / 2,
      y: iy + ih + 18,
      'text-anchor': 'middle',
      'font-size': 11,
      fill: toCssColor(e.axisColor ?? '4A365C', '#4A365C'),
    });
    t.textContent = lab;
    g.append(t);
  });

  return g;
}
