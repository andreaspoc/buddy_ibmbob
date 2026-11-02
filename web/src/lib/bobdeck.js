import {
  W, H, S, SVG_NS, normalizeHex, toCssColor, num,
  xOf, yOf, wOf, hOf, textOf, styleOf, fontSizeOf,
  boldOf, alignOf, colorOf, fillOf, strokeOf, lineWidthOf, shapeOf,
  slideBackground, themeForeground, themeAccent, chartSeries, clamp, svgEl, renderShapeSvg,
  isEmojiOrIconBadge, renderEmojiToDataUrl, renderCartesianChart,
} from '../../../frontend/bobdeck-common.js';
export {
  W, H, normalizeHex, toCssColor, num, xOf, yOf,
  wOf, hOf, textOf, styleOf, fontSizeOf, boldOf, alignOf,
  colorOf, fillOf, strokeOf, lineWidthOf, shapeOf, slideBackground, themeForeground,
  themeAccent, chartSeries,
} from '../../../frontend/bobdeck-common.js';



export function themeFont(theme) {
  return theme?.fonts?.body ?? theme?.font ?? 'IBM Plex Sans';
}

// --- Layout Resolver ---

export function resolveDeckLayout(inputDeck) {
  if (!inputDeck || typeof inputDeck !== 'object') {
    return { slides: [], theme: {}, title: 'Presentation' };
  }
  let deck;
  try {
    deck = JSON.parse(JSON.stringify(inputDeck));
  } catch {
    return { slides: [], theme: {}, title: 'Presentation' };
  }
  if (!deck || typeof deck !== 'object') {
    return { slides: [], theme: {}, title: 'Presentation' };
  }
  if (!Array.isArray(deck.slides)) {
    deck.slides = [];
  }
  for (const s of deck.slides) {
    if (!s || typeof s !== 'object') continue;
    if (!Array.isArray(s.elements)) s.elements = [];
    for (const e of s.elements) {
      if (!e || typeof e !== 'object') continue;
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

let textBoxSequence = 0;
function renderTextBoxSvg(e, font, color) {
  const x = xOf(e) * S, y = yOf(e) * S;
  const w = wOf(e) * S, h = hOf(e) * S;
  // Deck font sizes are PowerPoint points; SVG coordinates use 100 units/inch.
  const fs = fontSizeOf(e) * S / 72;
  const st = styleOf(e);
  const family = st.fontFamily ?? font;
  const weight = boldOf(e) ? 700 : 400;
  const italic = String(st.fontStyle ?? '').toLowerCase() === 'italic';
  const lineHeight = fs * (Number(st.lineHeight) || 1.2);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${fs}px "${family}"`;
  const lines = [];
  for (const paragraph of textOf(e).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > w) {
        lines.push(line);
        line = '';
      }
      if (line) line += ' ';
      // Break long URLs/identifiers as well as wrapping normal words.
      for (const char of word) {
        if (line && ctx.measureText(line + char).width > w) {
          lines.push(line.trimEnd());
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  const align = alignOf(e);
  const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
  const height = fs + Math.max(0, lines.length - 1) * lineHeight;
  const valign = st.valign ?? 'mid';
  const top = y + (valign === 'top' ? 0 : valign === 'bottom' ? Math.max(0, h - height) : Math.max(0, (h - height) / 2));
  const group = svgEl('g', { 'data-text-box': e.id ?? '' });
  const clipId = `bobdeck-text-${++textBoxSequence}`;
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: clipId });
  clip.append(svgEl('rect', { x, y, width: w, height: h }));
  defs.append(clip);
  group.append(defs);
  const text = svgEl('text', {
    x: tx, y: top + fs * 0.8, 'font-size': fs,
    'font-family': family, 'font-weight': weight,
    'font-style': italic ? 'italic' : 'normal', fill: color,
    'text-anchor': align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start',
    'clip-path': `url(#${clipId})`,
  });
  lines.forEach((line, i) => {
    const span = svgEl('tspan', { x: tx, y: top + fs * 0.8 + i * lineHeight });
    span.textContent = line;
    text.append(span);
  });
  group.append(text);
  return group;
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
      const segment = svgEl('path', { d, fill: toCssColor(palette[i % palette.length] ?? series[0]?.color, '#5B1F8A') });
      const title = svgEl('title');
      title.textContent = `${series[0]?.labels[i] ?? 'Category ' + (i + 1)}: ${v}`;
      segment.append(title);
      g.append(segment);
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
  for (const [elementIndex, e] of (slide?.elements || []).entries()) {
    if (!e || typeof e !== 'object') continue;
    try {
      const type = e.type;
      const x = xOf(e) * S;
      const y = yOf(e) * S;
      const w = wOf(e) * S;
      const h = hOf(e) * S;

      if (type === 'rect' || type === 'shape') {
        svg.append(renderShapeSvg(e));
      } else if (type === 'text') {
        const textBox = renderTextBoxSvg(e, font, toCssColor(colorOf(e) ?? fg, fg));
        textBox.setAttribute('data-element-index', elementIndex);
        svg.append(textBox);
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
          if (!Array.isArray(r)) return;
          r.forEach((v, ci) => {
            g.append(svgEl('rect', {
              x: x + (ci * w) / cols,
              y: y + (ri * h) / rows,
              width: w / cols,
              height: h / rows,
              fill: ri === 0 && e.header ? toCssColor(themeAccent(theme), '#5B1F8A') : '#FFFFFF',
              stroke: toCssColor(e.border?.color ?? 'E9D5FF', '#E9D5FF'),
            }));
            g.append(renderTextBoxSvg({
              type: 'text',
              x: (x + (ci * w) / cols + 8) / S,
              y: (y + (ri * h) / rows) / S,
              w: Math.max(0.01, (w / cols - 16) / S),
              h: h / rows / S,
              text: String(v ?? ''),
              fontSize: 14,
              style: { valign: 'mid' },
            }, font, ri === 0 && e.header ? '#FFFFFF' : fg));
          });
        });
        svg.append(g);
      }
    } catch (elemErr) {
      console.warn('Error rendering slide element:', elemErr, e);
    }
  }

  return svg;
}

// --- PPTX Exporter using PptxGenJS ---
async function buildDeckPptxInstance(rawDeck) {
  if (!rawDeck) {
    throw new Error('No presentation data provided to export.');
  }
  const resolved = resolveDeckLayout(rawDeck);
  if (!resolved.slides || resolved.slides.length === 0) {
    throw new Error('Presentation contains no slides to export.');
  }
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = String(resolved.metadata?.title ?? resolved.title ?? 'Presentation');
  pptx.author = String(resolved.metadata?.author ?? 'Buddy Presentation Studio');

  const theme = resolved.theme || {};
  const palette = ((Array.isArray(theme.chartPalette) ? theme.chartPalette : theme.colors?.chartPalette) ?? [
    themeAccent(theme), '8B2FC9', '6B21A8', 'C084FC',
  ]).map(c => normalizeHex(c, '5B1F8A'));

  for (const s of resolved.slides || []) {
    if (!s || typeof s !== 'object') continue;
    const slide = pptx.addSlide();
    slide.background = { color: normalizeHex(slideBackground(s, theme), 'FFFFFF') };

    for (const e of s.elements || []) {
      if (!e || typeof e !== 'object') continue;
      try {
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
            name: s.name || `Series ${si + 1}`,
            labels: Array.isArray(s.labels) ? s.labels : [],
            values: Array.isArray(s.values) ? s.values : [],
            color: normalizeHex(s.color ?? palette[si % palette.length], themeAccent(theme)),
          }));
          if (series.length > 0) {
            const categorical = ['pie', 'doughnut'].includes(String(e.chartType));
            const chartColors = categorical ? palette : series.map(s => s.color);
            slide.addChart(cmap[String(e.chartType ?? 'bar')] ?? ct.bar, series, {
              x, y, w, h,
              showLegend: e.showLegend ?? (categorical || series.length > 1),
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
          }
        } else if (e.type === 'table') {
          const rawRows = Array.isArray(e.rows) ? e.rows : [];
          if (rawRows.length > 0) {
            const tableRows = rawRows.map(r => Array.isArray(r) ? r.map(v => String(v ?? '')) : [String(r ?? '')]);
            slide.addTable(tableRows, {
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
      } catch (elemErr) {
        console.warn('Error adding element to PPTX slide, skipping element:', elemErr, e);
      }
    }
  }
  return pptx;
}

export async function buildDeckPptxBlob(rawDeck) {
  const pptx = await buildDeckPptxInstance(rawDeck);
  return await pptx.write({ outputType: 'blob' });
}

export async function exportDeckToPptx(rawDeck, fileName = 'presentation.pptx') {
  const pptx = await buildDeckPptxInstance(rawDeck);
  const safeFileName = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
  return await pptx.writeFile({ fileName: safeFileName });
}

export async function buildHtmlDeckPptxBlob({ title = 'Presentation', slides = [], colors = {} } = {}) {
  const bgHex = normalizeHex(colors.bg || '0D0818', '0D0818');
  const surfaceHex = normalizeHex(colors.surface || '1C1030', '1C1030');
  const primaryHex = normalizeHex(colors.brandPrimary || 'A63BFF', 'A63BFF');
  const secondaryHex = normalizeHex(colors.brandSecondary || 'FF7A1A', 'FF7A1A');
  const textHex = normalizeHex(colors.text || 'EEF3FA', 'EEF3FA');

  const deckSlides = slides.map((s, idx) => {
    const elements = [
      { type: 'shape', shape: 'rectangle', x: 0, y: 0, w: 0.22, h: 7.5, fill: primaryHex, stroke: primaryHex, lineWidth: 0 },
    ];
    if (s.kicker) {
      elements.push({
        type: 'text',
        text: String(s.kicker).toUpperCase(),
        x: 0.75, y: 0.55, w: 11.8, h: 0.4,
        fontSize: 13, bold: true, color: secondaryHex,
      });
    }
    elements.push({
      type: 'text',
      text: String(s.title || `Slide ${idx + 1}`),
      x: 0.75, y: s.kicker ? 1.0 : 0.7, w: 11.8, h: 0.9,
      fontSize: idx === 0 ? 34 : 28, bold: true, color: textHex,
    });
    const cards = Array.isArray(s.cards) && s.cards.length > 0 ? s.cards.slice(0, 6) : [];
    if (cards.length > 0) {
      const cols = Math.min(3, cards.length);
      const rows = Math.ceil(cards.length / cols);
      const cardW = (11.8 - (cols - 1) * 0.35) / cols;
      const cardH = rows > 1 ? 2.2 : 4.2;
      cards.forEach((card, cIdx) => {
        const col = cIdx % cols;
        const row = Math.floor(cIdx / cols);
        const cx = 0.75 + col * (cardW + 0.35);
        const cy = 2.15 + row * (cardH + 0.35);
        elements.push({
          type: 'shape', shape: 'roundedRectangle',
          x: cx, y: cy, w: cardW, h: cardH,
          fill: surfaceHex, stroke: primaryHex, lineWidth: 1,
        });
        if (card.heading) {
          elements.push({
            type: 'text', text: String(card.heading),
            x: cx + 0.25, y: cy + 0.2, w: cardW - 0.5, h: 0.55,
            fontSize: 18, bold: true, color: primaryHex,
          });
        }
        if (card.body) {
          elements.push({
            type: 'text', text: String(card.body),
            x: cx + 0.25, y: cy + (card.heading ? 0.85 : 0.25), w: cardW - 0.5, h: cardH - (card.heading ? 1.05 : 0.5),
            fontSize: 14, bold: false, color: textHex,
          });
        }
      });
    } else if (s.bodyText) {
      elements.push({
        type: 'shape', shape: 'roundedRectangle',
        x: 0.75, y: 2.1, w: 11.8, h: 4.5,
        fill: surfaceHex, stroke: primaryHex, lineWidth: 1,
      });
      elements.push({
        type: 'text', text: String(s.bodyText),
        x: 1.05, y: 2.35, w: 11.2, h: 4.0,
        fontSize: 16, bold: false, color: textHex,
      });
    }
    return {
      id: s.id || `slide-${idx + 1}`,
      layout: idx === 0 ? 'hero' : 'content',
      background: { color: bgHex },
      elements,
    };
  });

  return await buildDeckPptxBlob({
    title,
    theme: {
      colors: {
        primary: primaryHex,
        secondary: secondaryHex,
        accent: primaryHex,
        background: bgHex,
        text: textHex,
      },
    },
    slides: deckSlides,
  });
}

