import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import { renderSlideToSvg, exportDeckToPptx, resolveDeckLayout } from './bobdeck.js';
import { renderChartToDOM } from './chart.js';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  suppressErrorRendering: true,
  flowchart: { htmlLabels: true },
});
marked.setOptions({ gfm: true, breaks: true });

let diagramId = 0;
let deckViewerId = 0;

function extractBobDeckBlock(source) {
  if (!source) return null;
  // Match ```bobdeck ... ``` (or unclosed during streaming)
  const opening = /```bobdeck\s*/i.exec(source);
  if (opening) {
    const start = opening.index + opening[0].length;
    const end = source.indexOf('```', start);
    const rawBlock = source.slice(opening.index, end < 0 ? source.length : end + 3);
    return {
      rawBlock,
      codeContent: source.slice(start, end < 0 ? source.length : end).trim(),
      isClosed: rawBlock.trim().endsWith('```'),
    };
  }

  // Match ```json { ... "slides": ... }
  const jsonRegex = /```json\s*(\{[\s\S]*?"slides"\s*:\s*\[[\s\S]*?)(?:```|$)/i;
  const jsonMatch = source.match(jsonRegex);
  if (jsonMatch) {
    return {
      rawBlock: jsonMatch[0],
      codeContent: jsonMatch[1].trim(),
      isClosed: jsonMatch[0].trim().endsWith('```'),
    };
  }

  return null;
}

function parseBobDeckJson(text) {
  try {
    const trimmed = (text || '').trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return parsed;
    }
  } catch {
    // incomplete or invalid json
  }
  return null;
}

function renderMarkdown(element, source, diagrams = false) {
  const deckBlock = extractBobDeckBlock(source || '');
  let textToRender = source || '';
  let deckToRender = null;
  let rawDeckCode = '';

  if (deckBlock) {
    if (!diagrams) {
      // While streaming: hide the raw code and show an elegant generating indicator
      textToRender = source.replace(
        deckBlock.rawBlock,
        '\n\n<div class="bobdeck-generating-indicator"><span class="bobdeck-spinner">📊</span><div><strong>Generating presentation slides…</strong><small>Structuring executive cards, typography & charts</small></div></div>\n\n'
      );
    } else {
      // Complete: parse the JSON deck
      const parsed = parseBobDeckJson(deckBlock.codeContent);
      if (parsed) {
        deckToRender = parsed;
        rawDeckCode = deckBlock.codeContent;
        textToRender = source.replace(deckBlock.rawBlock, '\n\n<div class="bobdeck-viewer-placeholder"></div>\n\n');
      }
    }
  }

  const html = marked.parse(textToRender);
  element.innerHTML = DOMPurify.sanitize(html, {
    ADD_TAGS: ['foreignObject'],
    ADD_ATTR: ['target', 'rel'],
  });

  for (const link of element.querySelectorAll('a[href]')) {
    if (!/^https?:\/\//i.test(link.href)) {
      link.removeAttribute('href');
      continue;
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }

  if (diagrams) {
    void renderDiagrams(element);
    void renderCharts(element);
    const placeholder = element.querySelector('.bobdeck-viewer-placeholder');
    if (placeholder && deckToRender) {
      const viewer = createBobDeckViewer(deckToRender, rawDeckCode);
      placeholder.replaceWith(viewer);
    } else {
      renderBobDecks(element);
    }
  }
}

function renderCharts(element) {
  const chartCodes = element.querySelectorAll('pre > code.language-chart, pre > code.language-bobchart');
  chartCodes.forEach((code) => {
    const pre = code.parentElement;
    if (!pre) return;
    try {
      const spec = JSON.parse(code.textContent || '{}');
      const chartElement = renderChartToDOM(spec);
      pre.replaceWith(chartElement);
    } catch {
      // Leave code block as-is if invalid JSON
    }
  });
}

async function renderDiagrams(element) {
  for (const code of element.querySelectorAll('pre > code.language-mermaid')) {
    const pre = code.parentElement;
    const source = code.textContent;
    const panel = document.createElement('div');
    panel.className = 'mermaid-panel';
    const header = document.createElement('div');
    header.className = 'mermaid-header';
    const caption = document.createElement('div');
    caption.className = 'mermaid-caption';
    caption.textContent = 'Diagram';
    const fitButton = document.createElement('button');
    fitButton.type = 'button';
    fitButton.className = 'mermaid-fit';
    fitButton.textContent = 'Fit to width';
    fitButton.hidden = true;
    header.append(caption, fitButton);
    const diagram = document.createElement('div');
    diagram.className = 'mermaid-diagram';
    const details = document.createElement('details');
    details.className = 'mermaid-source';
    const summary = document.createElement('summary');
    summary.textContent = 'View Mermaid source';
    details.append(summary, pre.cloneNode(true));
    panel.append(header, diagram, details);
    pre.replaceWith(panel);
    try {
      const result = await mermaid.render(`bob-diagram-${++diagramId}`, source);
      diagram.innerHTML = DOMPurify.sanitize(result.svg, { ADD_TAGS: ['foreignObject'] });
      const svg = diagram.querySelector('svg');
      const naturalWidth = Math.ceil(svg?.viewBox.baseVal.width || 0);
      if (svg && naturalWidth) {
        svg.style.width = `${naturalWidth}px`;
        svg.style.maxWidth = 'none';
        svg.style.height = 'auto';
        if (naturalWidth > diagram.clientWidth) {
          fitButton.hidden = false;
          fitButton.addEventListener('click', () => {
            const fitted = diagram.classList.toggle('fitted');
            fitButton.textContent = fitted ? 'Actual size' : 'Fit to width';
            diagram.scrollLeft = 0;
          });
        }
      }
      const rawSvg = document.createElement('template');
      rawSvg.innerHTML = result.svg;
      const rawLabels = [...rawSvg.content.querySelectorAll('foreignObject')];
      const safeLabels = [...diagram.querySelectorAll('foreignObject')];
      safeLabels.forEach((container, index) => {
        const label = document.createElement('template');
        label.innerHTML = DOMPurify.sanitize(rawLabels[index]?.innerHTML || '', {
          USE_PROFILES: { html: true },
        });
        container.replaceChildren(label.content);
      });
    } catch {
      caption.textContent = 'Diagram could not be rendered';
      details.open = true;
    }
  }
}

function renderBobDecks(element) {
  for (const code of element.querySelectorAll('pre > code')) {
    const isBobdeckLang = code.classList.contains('language-bobdeck');
    const isJsonLang = code.classList.contains('language-json');
    if (!isBobdeckLang && !isJsonLang && code.className) continue;

    const source = code.textContent;
    const deck = parseBobDeckJson(source);
    if (!deck) continue;

    const pre = code.parentElement;
    const viewer = createBobDeckViewer(deck, source);
    pre.replaceWith(viewer);
  }
}

export function createBobDeckViewer(deckData, rawJson = '') {
  const viewerId = ++deckViewerId;
  const resolved = resolveDeckLayout(deckData);
  const slides = resolved.slides || [];
  let currentSlideIndex = 0;

  const container = document.createElement('div');
  container.className = 'bobdeck-viewer';
  container.id = `bobdeck-viewer-${viewerId}`;

  // Top header bar
  const header = document.createElement('div');
  header.className = 'bobdeck-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'bobdeck-title-wrap';

  const brandPill = document.createElement('span');
  brandPill.className = 'bobdeck-brand-pill';
  brandPill.textContent = deckData.metadata?.brand || 'BobDeck';

  const titleText = document.createElement('strong');
  titleText.className = 'bobdeck-title';
  titleText.textContent = deckData.title || 'Executive Presentation';

  titleWrap.append(brandPill, titleText);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'bobdeck-actions';

  const pptxBtn = document.createElement('button');
  pptxBtn.type = 'button';
  pptxBtn.className = 'bobdeck-btn bobdeck-btn-primary';
  pptxBtn.innerHTML = '<span aria-hidden="true">📊</span> Download PPTX';
  pptxBtn.title = 'Download PowerPoint presentation (.pptx)';
  pptxBtn.addEventListener('click', async () => {
    try {
      pptxBtn.disabled = true;
      pptxBtn.textContent = 'Generating PPTX…';
      const cleanName = (deckData.title || 'presentation').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      await exportDeckToPptx(deckData, `${cleanName}.pptx`);
    } catch (err) {
      console.error('PPTX export error:', err);
      alert('PPTX Export failed: ' + (err.message || String(err)));
    } finally {
      pptxBtn.disabled = false;
      pptxBtn.innerHTML = '<span aria-hidden="true">📊</span> Download PPTX';
    }
  });

  const jsonBtn = document.createElement('button');
  jsonBtn.type = 'button';
  jsonBtn.className = 'bobdeck-btn';
  jsonBtn.innerHTML = '<span aria-hidden="true">💾</span> .bobdeck';
  jsonBtn.title = 'Download raw .bobdeck JSON file';
  jsonBtn.addEventListener('click', () => {
    const blob = new Blob([rawJson || JSON.stringify(deckData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(deckData.title || 'presentation').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.bobdeck`;
    a.click();
    URL.revokeObjectURL(url);
  });

  actions.append(pptxBtn, jsonBtn);
  header.append(titleWrap, actions);

  // Main Canvas Stage
  const stage = document.createElement('div');
  stage.className = 'bobdeck-stage';

  const stageSvgWrap = document.createElement('div');
  stageSvgWrap.className = 'bobdeck-stage-canvas';

  // Navigation Overlay Arrows
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'bobdeck-nav-btn bobdeck-nav-prev';
  prevBtn.innerHTML = '‹';
  prevBtn.setAttribute('aria-label', 'Previous slide');

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'bobdeck-nav-btn bobdeck-nav-next';
  nextBtn.innerHTML = '›';
  nextBtn.setAttribute('aria-label', 'Next slide');

  stage.append(prevBtn, stageSvgWrap, nextBtn);

  // Bottom Navigation & Info Bar
  const navBar = document.createElement('div');
  navBar.className = 'bobdeck-navbar';

  const slideCounter = document.createElement('span');
  slideCounter.className = 'bobdeck-counter';

  const navControls = document.createElement('div');
  navControls.className = 'bobdeck-controls';

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.type = 'button';
  fullscreenBtn.className = 'bobdeck-btn bobdeck-btn-sm';
  fullscreenBtn.textContent = '⛶ Fullscreen';
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  navControls.append(fullscreenBtn);
  navBar.append(slideCounter, navControls);

  // Thumbnails Strip
  const thumbs = document.createElement('div');
  thumbs.className = 'bobdeck-thumbs';

  function updateView() {
    if (slides.length === 0) return;
    currentSlideIndex = Math.max(0, Math.min(currentSlideIndex, slides.length - 1));

    // Render active slide SVG
    stageSvgWrap.innerHTML = '';
    const activeSlide = slides[currentSlideIndex];
    const mainSvg = renderSlideToSvg(activeSlide, deckData.theme);
    stageSvgWrap.append(mainSvg);

    // Update Counter
    slideCounter.textContent = `Slide ${currentSlideIndex + 1} of ${slides.length}`;
    prevBtn.disabled = currentSlideIndex === 0;
    nextBtn.disabled = currentSlideIndex === slides.length - 1;

    // Update Thumbnails active state
    thumbs.querySelectorAll('.bobdeck-thumb').forEach((thumb, idx) => {
      if (idx === currentSlideIndex) {
        thumb.classList.add('active');
        thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } else {
        thumb.classList.remove('active');
      }
    });
  }

  prevBtn.addEventListener('click', () => {
    if (currentSlideIndex > 0) {
      currentSlideIndex--;
      updateView();
    }
  });

  nextBtn.addEventListener('click', () => {
    if (currentSlideIndex < slides.length - 1) {
      currentSlideIndex++;
      updateView();
    }
  });

  // Build Thumbnail Cards
  slides.forEach((s, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'bobdeck-thumb' + (idx === 0 ? ' active' : '');
    thumb.setAttribute('tabindex', '0');
    thumb.setAttribute('role', 'button');
    thumb.setAttribute('aria-label', `Go to slide ${idx + 1}`);

    const thumbSvgWrap = document.createElement('div');
    thumbSvgWrap.className = 'bobdeck-thumb-svg';
    const miniSvg = renderSlideToSvg(s, deckData.theme);
    thumbSvgWrap.append(miniSvg);

    const thumbLabel = document.createElement('div');
    thumbLabel.className = 'bobdeck-thumb-label';
    const firstText = (s.elements || []).find(e => e.type === 'text');
    const labelTitle = firstText ? String(firstText.text || firstText.content || '').split('\n')[0].slice(0, 20) : `Slide ${idx + 1}`;
    thumbLabel.textContent = `${idx + 1}. ${labelTitle}`;

    thumb.append(thumbSvgWrap, thumbLabel);
    thumb.addEventListener('click', () => {
      currentSlideIndex = idx;
      updateView();
    });
    thumb.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        currentSlideIndex = idx;
        updateView();
        e.preventDefault();
      }
    });

    thumbs.append(thumb);
  });

  // Submenu: Presentation Code Collapsible
  const details = document.createElement('details');
  details.className = 'bobdeck-source-details';
  const summary = document.createElement('summary');
  summary.innerHTML = '<span aria-hidden="true">⟨/⟩</span> View presentation code (.bobdeck JSON)';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-json';
  code.textContent = rawJson || JSON.stringify(deckData, null, 2);
  pre.append(code);
  details.append(summary, pre);

  container.append(header, stage, navBar, thumbs, details);
  updateView();
  return container;
}

window.BobRenderer = {
  renderMarkdown,
  createBobDeckViewer,
  exportDeckToPptx,
};
