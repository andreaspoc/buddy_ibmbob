import {
  W, H, S, SVG_NS, normalizeHex, toCssColor, num,
  xOf, yOf, wOf, hOf, textOf, styleOf, fontSizeOf,
  boldOf, alignOf, colorOf, fillOf, strokeOf, lineWidthOf, shapeOf,
  slideBackground, themeForeground, themeAccent, chartSeries, clamp, svgEl, renderShapeSvg,
  isEmojiOrIconBadge, renderEmojiToDataUrl, renderCartesianChart,
} from './bobdeck-common.js';
export {
  W, H, normalizeHex, toCssColor, num, xOf, yOf,
  wOf, hOf, textOf, styleOf, fontSizeOf, boldOf, alignOf,
  colorOf, fillOf, strokeOf, lineWidthOf, shapeOf, slideBackground, themeForeground,
  themeAccent, chartSeries,
} from './bobdeck-common.js';
import PptxGenJS from 'pptxgenjs';



export function themeFont(theme) {
  return theme?.fonts?.body ?? theme?.font ?? 'Calibri';
}

// --- Layout Resolver ---

export function resolveDeckLayout(inputDeck) {
  const deck = JSON.parse(JSON.stringify(inputDeck));
  for (const s of deck.slides || []) {
    for (const e of s.elements || []) {
      let x = xOf(e), y = yOf(e), w = wOf(e), h = hOf(e);
      w = clamp(w, 0.01, W);
      h = clamp(h, 0.01, H);
      x = clamp(x, 0, Math.max(0, W - w));
      y = clamp(y, 0, Math.max(0, H - h));
      e.x = x;
      e.y = y;
      if ('width' in e && !('w' in e)) e.width = w; else e.w = w;
      if ('height' in e && !('h' in e)) e.height = h; else e.h = h;
    }
  }
  return deck;
}

// --- SVG Slide Renderer ---

function renderMultilineText(el, text, fontSize, lineHeight = 1.2) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const tspan = svgEl('tspan', {
      x: el.getAttribute('x'),
      dy: i === 0 ? 0 : fontSize * lineHeight,
    });
    tspan.textContent = line;
    el.append(tspan);
  });
}

function renderChartSvg(e, palette) {
  const g = svgEl('g');
  const x = xOf(e) * S;
  const y = yOf(e) * S;
  const w = wOf(e) * S;
  const h = hOf(e) * S;
  const series = chartSeries(e);
  const type = String(e.chartType ?? 'bar');

  // Chart background card
  g.append(svgEl('rect', {
    x, y, width: w, height: h, rx: 8,
    fill: toCssColor(e.background ?? 'FFFFFF', '#FFFFFF'),
    stroke: toCssColor(e.border?.color ?? 'E9D5FF', '#E9D5FF'),
  }));

  // Title
  if (e.title) {
    const t = svgEl('text', {
      x: x + 18, y: y + 26, 'font-size': 15, 'font-weight': 700,
      fill: toCssColor(e.titleColor ?? '1A0A2E', '#1A0A2E'),
    });
    t.textContent = e.title;
    g.append(t);
  }

  const top = e.title ? 40 : 16;
  const pad = 24;
  const ix = x + pad;
  const iy = y + top;
  const iw = Math.max(10, w - pad * 2);
  const ih = Math.max(10, h - top - 34);

  if (type === 'pie' || type === 'doughnut') {
    const vals = series[0]?.values ?? [];
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = ix + iw / 2;
    const cy = iy + ih / 2;
    const r = Math.max(8, Math.min(iw, ih) * 0.38);
    let a = -Math.PI / 2;

    vals.forEach((v, i) => {
      const da = (Math.max(0, v) / total) * Math.PI * 2;
      const a2 = a + da;
      const large = da > Math.PI ? 1 : 0;
      const p1 = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const p2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)];
      const d = `M ${cx} ${cy} L ${p1[0]} ${p1[1]} A ${r} ${r} 0 ${large} 1 ${p2[0]} ${p2[1]} Z`;
      g.append(svgEl('path', { d, fill: toCssColor(series[0]?.color ?? palette[i % palette.length], '#5B1F8A') }));
      a = a2;
    });

    if (type === 'doughnut') {
      g.append(svgEl('circle', { cx, cy, r: r * 0.5, fill: toCssColor(e.background ?? 'FFFFFF', '#FFFFFF') }));
    }
    return g;
  }

  return renderCartesianChart({e, series, type, ix, iy, iw, ih, g, palette});
}

export function renderSlideToSvg(slide, theme = {}) {
  const svg = svgEl('svg', {
    viewBox: '0 0 1333 750',
    xmlns: SVG_NS,
    class: 'bobdeck-slide-svg',
  });

  // Slide Background
  const bg = toCssColor(slideBackground(slide, theme), '#FFFFFF');
  svg.append(svgEl('rect', { width: 1333, height: 750, fill: bg }));

  const font = themeFont(theme);
  const fg = toCssColor(themeForeground(theme), '#1A0A2E');
  const palette = (theme.chartPalette ?? theme.colors?.chartPalette ?? ['5B1F8A', '8B2FC9', '6B21A8', 'C084FC']).map(c => toCssColor(c));

  // Render elements in order
  for (const e of slide.elements || []) {
    const type = e.type;
    const x = xOf(e) * S;
    const y = yOf(e) * S;
    const w = wOf(e) * S;
    const h = hOf(e) * S;

    if (type === 'rect' || type === 'shape') {
      svg.append(renderShapeSvg(e));
    } else if (type === 'text') {
      const align = alignOf(e);
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
      const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
      const fs = fontSizeOf(e);
      const textEl = svgEl('text', {
        x: tx,
        y: y + fs,
        'font-size': fs,
        'font-family': styleOf(e).fontFamily ?? font,
        'font-weight': boldOf(e) ? 700 : 400,
        'font-style': String(styleOf(e).fontStyle ?? '').toLowerCase() === 'italic' ? 'italic' : 'normal',
        fill: toCssColor(colorOf(e) ?? fg, fg),
        'text-anchor': anchor,
      });
      renderMultilineText(textEl, textOf(e), fs, Number(styleOf(e).lineHeight) || 1.2);
      svg.append(textEl);
    } else if (type === 'chart') {
      svg.append(renderChartSvg(e, palette));
    } else if (type === 'line') {
      svg.append(svgEl('line', {
        x1: x, y1: y, x2: x + w, y2: y + h,
        stroke: toCssColor(colorOf(e) ?? themeAccent(theme), '#5B1F8A'),
        'stroke-width': lineWidthOf(e),
      }));
    } else if (type === 'table') {
      const g = svgEl('g');
      const data = Array.isArray(e.rows) ? e.rows : [];
      const rows = data.length || 1;
      const cols = Math.max(1, ...data.map(r => (Array.isArray(r) ? r.length : 0)));
      data.forEach((r, ri) => {
        r.forEach((v, ci) => {
          g.append(svgEl('rect', {
            x: x + (ci * w) / cols,
            y: y + (ri * h) / rows,
            width: w / cols,
            height: h / rows,
            fill: ri === 0 && e.header ? toCssColor(themeAccent(theme), '#5B1F8A') : '#FFFFFF',
            stroke: toCssColor(e.border?.color ?? 'E9D5FF', '#E9D5FF'),
          }));
          const t = svgEl('text', {
            x: x + (ci * w) / cols + 8,
            y: y + ((ri + 0.65) * h) / rows,
            'font-size': 13,
            fill: ri === 0 && e.header ? '#FFFFFF' : fg,
          });
          t.textContent = String(v);
          g.append(t);
        });
      });
      svg.append(g);
    }
  }

  return svg;
}

// --- PPTX Exporter using PptxGenJS ---
export async function exportDeckToPptx(rawDeck, fileName = 'presentation.pptx') {
  const resolved = resolveDeckLayout(rawDeck);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = String(resolved.metadata?.title ?? resolved.title ?? 'Presentation');
  pptx.author = String(resolved.metadata?.author ?? 'Buddy Presentation Studio');

  const theme = resolved.theme || {};
  const palette = ((Array.isArray(theme.chartPalette) ? theme.chartPalette : theme.colors?.chartPalette) ?? [
    themeAccent(theme), '8B2FC9', '6B21A8', 'C084FC',
  ]).map(c => normalizeHex(c, '5B1F8A'));

  for (const s of resolved.slides || []) {
    const slide = pptx.addSlide();
    slide.background = { color: normalizeHex(slideBackground(s, theme), 'FFFFFF') };

    for (const e of s.elements || []) {
      const x = xOf(e);
      const y = yOf(e);
      const w = Math.max(0.01, wOf(e));
      const h = Math.max(0.01, hOf(e));
      const st = styleOf(e);

      if (e.type === 'text') {
        const txt = textOf(e);
        // If element is an icon badge, rasterize it to an image so ONLYOFFICE / PowerPoint never shows [?]
        if (isEmojiOrIconBadge(txt)) {
          const imgData = renderEmojiToDataUrl(txt, colorOf(e) || 'FFFFFF');
          if (imgData) {
            const iconDim = Math.min(w, h);
            const ix = x + (w - iconDim) / 2;
            const iy = y + (h - iconDim) / 2;
            slide.addImage({
              data: imgData,
              x: ix,
              y: iy,
              w: iconDim,
              h: iconDim,
            });
            continue;
          }
        }

        slide.addText(txt, {
          x, y, w, h,
          fontFace: String(st.fontFamily ?? themeFont(theme)),
          fontSize: fontSizeOf(e),
          bold: boldOf(e),
          italic: String(st.fontStyle ?? '').toLowerCase() === 'italic',
          color: normalizeHex(colorOf(e) ?? themeForeground(theme), '1A0A2E'),
          align: alignOf(e),
          valign: st.valign ?? 'mid',
          margin: 0,
          breakLine: false,
        });
      } else if (e.type === 'rect' || e.type === 'shape') {
        const types = pptx.ShapeType;
        const smap = {
          rectangle: types.rect,
          rect: types.rect,
          roundedRectangle: types.roundRect,
          roundRect: types.roundRect,
          ellipse: types.ellipse,
          circle: types.ellipse,
          triangle: types.triangle,
          diamond: types.diamond,
          chevron: types.chevron,
          hexagon: types.hexagon,
          pentagon: types.pentagon,
        };
        slide.addShape(smap[shapeOf(e)] ?? types.rect, {
          x, y, w, h,
          fill: { color: normalizeHex(fillOf(e), 'F5EEFF'), transparency: Number(e.transparency ?? 0) },
          line: { color: normalizeHex(strokeOf(e) ?? fillOf(e), '5B1F8A'), width: lineWidthOf(e) },
        });
      } else if (e.type === 'line') {
        slide.addShape(pptx.ShapeType.line, {
          x, y, w, h,
          line: {
            color: normalizeHex(colorOf(e), '5B1F8A'),
            width: lineWidthOf(e),
            beginArrowType: e.beginArrowType,
            endArrowType: e.endArrowType,
          },
        });
      } else if (e.type === 'chart') {
        const ct = pptx.ChartType;
        const cmap = { bar: ct.bar, column: ct.bar, line: ct.line, pie: ct.pie, doughnut: ct.doughnut };
        const series = chartSeries(e).map((s, si) => ({
          name: s.name,
          labels: s.labels,
          values: s.values,
          color: normalizeHex(s.color ?? palette[si % palette.length], themeAccent(theme)),
        }));
        const chartColors = series.map(s => s.color);
        slide.addChart(cmap[String(e.chartType ?? 'bar')] ?? ct.bar, series, {
          x, y, w, h,
          showLegend: e.showLegend ?? series.length > 1,
          legendPos: e.legendPosition ?? 'b',
          showValue: e.showValues ?? false,
          showTitle: Boolean(e.title),
          title: String(e.title ?? ''),
          chartColors,
          showCatName: false,
          showPercent: String(e.chartType) === 'pie' || String(e.chartType) === 'doughnut',
          catAxisLabelColor: normalizeHex(e.axisColor ?? themeForeground(theme), '1A0A2E'),
          valAxisLabelColor: normalizeHex(e.axisColor ?? themeForeground(theme), '1A0A2E'),
        });
      } else if (e.type === 'table') {
        slide.addTable((e.rows || []).map(r => r.map(v => String(v))), {
          x, y, w, h,
          fontFace: themeFont(theme),
          fontSize: 14,
          color: normalizeHex(e.color ?? themeForeground(theme), '1A0A2E'),
          fill: { color: normalizeHex(e.fill ?? 'FFFFFF', 'FFFFFF') },
          border: { type: 'solid', color: normalizeHex(e.border?.color ?? 'E9D5FF', 'E9D5FF'), pt: Number(e.border?.width ?? 1) },
          margin: 0.05,
        });
      }
    }
  }

  const safeFileName = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
  return await pptx.writeFile({ fileName: safeFileName });
}
