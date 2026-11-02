import { withPresentationTypography } from '../lib/presentationTypography';
import { Toolbar } from './Toolbar';
import { isCompleteHtmlDeck, shouldWaitForHtmlDeck } from '../lib/htmlDeckReadiness';
import { SavedArtifactReview } from './ArtifactReviewComments';
import { t } from "../lib/i18n";
import { appConfirm, appAlert } from './AppDialog';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { saveSessionFile } from '../api';
import { navigateOffice } from '../lib/officeUrl';
// @ts-ignore
import { buildHtmlDeckPptxBlob } from '../lib/bobdeck.js';

import { protectPresentationTyping, removablePresentationElement } from '../lib/presentationEditing';
import { syncPresentationDocument } from '../lib/presentationDom';
import { sanitizeEditablePresentation, restorePresentationSource, livePresentationSource, sandboxedPresentationPage, validPresentationSnapshot, EDITABLE_PRESENTATION_SANDBOX, LIVE_PRESENTATION_SANDBOX } from '../lib/presentationSecurity';
import { ArtifactChangeRequest } from './ArtifactChangeRequest';

interface HtmlDeckViewerProps {
  restrictedScripts?: boolean;
  officeFileId?: string;
  onSaveHtml?: (html: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  isWorking?: boolean;
  htmlContent?: string;
  filename?: string;
  sessionId?: string;
  title?: string;
}

interface DeckColors {
  brandPrimary: string;
  brandSecondary: string;
  brandBlue: string;
  bg: string;
  surface: string;
  text: string;
}

interface SlideItem {
  index: number;
  id: string;
  title: string;
  kicker: string;
  previewText: string;
}

interface ChartItem {
  id: string;
  name: string;
  type: string;
  labels: string[];
  values: number[];
}

const DEFAULT_COLORS: DeckColors = {
  brandPrimary: '#a63bff',
  brandSecondary: '#ff7a1a',
  brandBlue: '#5b8def',
  bg: '#0d0818',
  surface: '#1c1030',
  text: '#eef3fa',
};

const COLOR_PRESETS: Array<{
  name: string;
  icon: string;
  colors: DeckColors;
}> = [
  {
    name: 'Violet & Orange',
    icon: '🟣',
    colors: {
      brandPrimary: '#a63bff',
      brandSecondary: '#ff7a1a',
      brandBlue: '#5b8def',
      bg: '#0d0818',
      surface: '#1c1030',
      text: '#eef3fa',
    },
  },
  {
    name: 'IBM Tech Blue & Cyan',
    icon: '🔵',
    colors: {
      brandPrimary: '#0f62fe',
      brandSecondary: '#00d4ff',
      brandBlue: '#4589ff',
      bg: '#050a14',
      surface: '#111b2e',
      text: '#f4f6fc',
    },
  },
  {
    name: 'Emerald & Lime Modern',
    icon: '🟢',
    colors: {
      brandPrimary: '#10b981',
      brandSecondary: '#84cc16',
      brandBlue: '#06b6d4',
      bg: '#06140e',
      surface: '#0d281e',
      text: '#f0fdf4',
    },
  },
  {
    name: 'Crimson & Sunset',
    icon: '🔴',
    colors: {
      brandPrimary: '#e11d48',
      brandSecondary: '#fb7185',
      brandBlue: '#fb923c',
      bg: '#16050b',
      surface: '#2a0c16',
      text: '#fff1f2',
    },
  },
  {
    name: 'Clean Executive Light',
    icon: '☀️',
    colors: {
      brandPrimary: '#6d28d9',
      brandSecondary: '#ea580c',
      brandBlue: '#2563eb',
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
    },
  },
];

export { isCompleteHtmlDeck } from '../lib/htmlDeckReadiness';

export const HtmlDeckViewer: React.FC<HtmlDeckViewerProps> = ({
  htmlContent: initialHtmlContent,
  filename = 'presentation.html',
  sessionId,
  title,
  isWorking = false,
  onSaveHtml,
  onDirtyChange,
  restrictedScripts = false,
  officeFileId,
}) => {
  const [htmlOfficeFile, setHtmlOfficeFile] = useState<{id:string;name:string} | null>(null);
  const [savingHtmlOffice, setSavingHtmlOffice] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [livePreview, setLivePreview] = useState(false);
  const [currentHtml, setCurrentHtml] = useState<string>(initialHtmlContent || '');
  const [savedHtml, setSavedHtml] = useState<string>(initialHtmlContent || '');
  const [isEditingText, setIsEditingText] = useState(false);
  const [selectingObjects, setSelectingObjects] = useState(false);
  const [selectedObject, setSelectedObject] = useState<Element | null>(null);
  const [frameVersion, setFrameVersion] = useState(0);
  const [removedObjects, setRemovedObjects] = useState<Array<{node: Element; parent: Node; next: Node | null}>>([]);
  const typingCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => typingCleanup.current?.(), []);
  const [showColorPanel, setShowColorPanel] = useState(false);
  const [showFilmstrip, setShowFilmstrip] = useState(false);
  const [showDataModal, setShowDataModal] = useState(false);
  const [colors, setColors] = useState<DeckColors>(DEFAULT_COLORS);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  // Slides & navigation
  const [slides, setSlides] = useState<SlideItem[]>([]);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [followNewSlides, setFollowNewSlides] = useState(true);

  // Editable chart datasets
  const [detectedCharts, setDetectedCharts] = useState<ChartItem[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const liveIframeRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (restrictedScripts) setLivePreview(false);
  }, [restrictedScripts]);
  useEffect(() => {
    if (restrictedScripts) return;
    let acceptedBytes = 0;
    const receive = (event: MessageEvent) => {
      // Opaque-origin srcDoc iframe: verify source window instead of origin.
      if (event.source !== liveIframeRef.current?.contentWindow || event.data?.type !== 'buddy-presentation-raster' || Object.keys(event.data).length !== 2) return;
      const images = event.data.images;
      if (!Array.isArray(images) || images.length > 20) return;
      let total = 0;
      for (const item of images) {
        if (!validPresentationSnapshot(item)) continue;
        total += item.png.length;
        acceptedBytes += item.png.length;
        if (total > 4_000_000 || acceptedBytes > 4_000_000) break;
        const canvas = iframeRef.current?.contentDocument?.querySelectorAll('canvas')[item.index];
        if (!canvas || canvas.width > 4096 || canvas.height > 4096) continue;
        const image = new Image();
        image.onload = () => {
          if (canvas.isConnected && image.naturalWidth <= 4096 && image.naturalHeight <= 4096) {
            canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
          }
        };
        image.src = item.png;
      }
    };
    window.addEventListener('message', receive); // NOSONAR: source window is verified above
    return () => window.removeEventListener('message', receive);
  }, [restrictedScripts, savedHtml]);
  const rawHtmlRef = useRef<string>(initialHtmlContent || '');
  const [frameHtml, setFrameHtml] = useState(initialHtmlContent || '');
  const lastFrameHtml = useRef(initialHtmlContent || '');
  useEffect(() => {
    if (!currentHtml || currentHtml === lastFrameHtml.current) return;
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body && lastFrameHtml.current) {
      const active = doc.querySelector('.slide.active');
      const activeId = active?.id;
      const activeIndex = Array.from(doc.querySelectorAll('.slide')).indexOf(active as Element);
      syncPresentationDocument(doc, sanitizeEditablePresentation(withPresentationTypography(currentHtml)));
      const slideEls = Array.from(doc.querySelectorAll('.slide'));
      const selected = (activeId ? slideEls.findIndex(el => el.id === activeId) : activeIndex);
      if (selected >= 0) slideEls.forEach((el, index) => el.classList.toggle('active', index === selected));
      refreshSlideList();
      scanChartsAndMetrics();
    }
    lastFrameHtml.current = currentHtml;
  }, [currentHtml]);

  const wasWorkingRef = useRef(isWorking);
  useEffect(() => {
    if (wasWorkingRef.current && !isWorking && currentHtml && isCompleteHtmlDeck(currentHtml)) {
      setFrameHtml(currentHtml);
    }
    wasWorkingRef.current = isWorking;
  }, [isWorking, currentHtml]);
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  const chooseObject = (element: Element | null) => {
    iframeRef.current?.contentDocument?.querySelectorAll('[data-bob-selected]').forEach(el => el.removeAttribute('data-bob-selected'));
    const selected = removablePresentationElement(element) ? element : null;
    selected?.setAttribute('data-bob-selected', 'true');
    setSelectedObject(selected);
  };
  const removeObject = () => {
    if (!selectedObject?.isConnected || !removablePresentationElement(selectedObject) || isWorking) return;
    const parent = selectedObject.parentNode!;
    const next = selectedObject.nextSibling;
    selectedObject.removeAttribute('data-bob-selected');
    selectedObject.remove();
    setRemovedObjects(items => [...items, { node: selectedObject, parent, next }]);
    setSelectedObject(null);
    setIsDirty(true);
  };
  const undoRemoval = () => {
    const item = removedObjects[removedObjects.length - 1];
    if (!item?.parent.isConnected || isWorking) return;
    item.parent.insertBefore(item.node, item.next?.parentNode === item.parent ? item.next : null);
    setRemovedObjects(items => items.slice(0, -1));
    chooseObject(item.node);
    setIsDirty(true);
  };
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc || !selectingObjects || isWorking) { chooseObject(null); return; }
    const style = doc.createElement('style');
    style.id = 'bob-object-edit-style';
    style.textContent = '[data-bob-selected] { outline: 2px solid #a855f7 !important; outline-offset: 3px !important; }';
    doc.head.appendChild(style);
    const select = (event: MouseEvent) => {
      const element = event.target as Element;
      if (!removablePresentationElement(element)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      chooseObject(element);
    };
    doc.addEventListener('click', select, true);
    return () => { doc.removeEventListener('click', select, true); style.remove(); doc.querySelectorAll('[data-bob-selected]').forEach(el => el.removeAttribute('data-bob-selected')); };
  }, [selectingObjects, isWorking, frameVersion]);

  useEffect(() => { setRemovedObjects([]); setSelectedObject(null); }, [filename, sessionId]);

  // Extract initial title
  const displayTitle =
    title ||
    (currentHtml ? currentHtml.match(/<title>([^<]+)<\/title>/i)?.[1] : null) ||
    filename.replace(/\.html$/i, '').replace(/_/g, ' ') ||
    'Interactive Presentation';

  // Helper to extract colors from HTML :root styles
  const extractColorsFromHtml = useCallback((html: string): DeckColors => {
    const brandPrimary = html.match(/--brand-primary:([^;]+);/i)?.[1]?.trim() || DEFAULT_COLORS.brandPrimary;
    const brandSecondary = html.match(/--brand-secondary:([^;]+);/i)?.[1]?.trim() || DEFAULT_COLORS.brandSecondary;
    const brandBlue = html.match(/--brand-blue:([^;]+);/i)?.[1]?.trim() || DEFAULT_COLORS.brandBlue;
    const bg = html.match(/--bg:([^;]+);/i)?.[1]?.trim() || DEFAULT_COLORS.bg;
    const surface = html.match(/--surface:([^;]+);/i)?.[1]?.trim() || DEFAULT_COLORS.surface;
    const text = html.match(/--text:([^;]+);/i)?.[1]?.trim() || DEFAULT_COLORS.text;

    return { brandPrimary, brandSecondary, brandBlue, bg, surface, text };
  }, []);

  // Fetch file content if only filename is available
  useEffect(() => {
    let isCancelled = false;

    if (initialHtmlContent) {
      // A file can be observed midway through a write. Keep the last valid frame.
      if (!officeFileId && !isCompleteHtmlDeck(initialHtmlContent) && isCompleteHtmlDeck(rawHtmlRef.current)) return;
      if (initialHtmlContent === rawHtmlRef.current) { setSavedHtml(initialHtmlContent); return; }
      setCurrentHtml(initialHtmlContent);
      setSavedHtml(initialHtmlContent);
      setIsDirty(false);
      setIsEditingText(false);
      rawHtmlRef.current = initialHtmlContent;
      setColors(extractColorsFromHtml(initialHtmlContent));
      return;
    }

    if (!filename) return;

    const endpoints = sessionId
      ? [
          `/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filename)}`,
          `/workspace/page?path=${encodeURIComponent(filename)}&session_id=${encodeURIComponent(sessionId)}`,
        ]
      : [
          `/workspace/page?path=${encodeURIComponent(filename)}`,
          `/workspace/${encodeURIComponent(filename)}`,
          `/sessions/legacy/file?path=${encodeURIComponent(filename)}`,
        ];

    const loadFromEndpoints = async () => {
      let found = false;
      for (const url of endpoints) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;

          const cType = res.headers.get('content-type') || '';
          let text = '';
          if (cType.includes('application/json')) {
            const data = await res.json();
            text = data.html || '';
          } else {
            text = await res.text();
          }

          if (text && text.trim().length > 0 && !isCancelled) {
            setCurrentHtml(text);
            setSavedHtml(text);
            rawHtmlRef.current = text;
            setColors(extractColorsFromHtml(text));
            found = true;
            return;
          }
        } catch {}
      }
      if (!found && !isCancelled) {
        setLoadFailed(true);
      }
    };

    void loadFromEndpoints();

    return () => {
      isCancelled = true;
    };
  }, [initialHtmlContent, filename, sessionId, reloadCounter, extractColorsFromHtml, officeFileId]);

  // Handle Fullscreen events & keyboard shortcuts
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen =
        !!document.fullscreenElement && document.fullscreenElement === containerRef.current;
      setIsFullscreen(isNowFullscreen);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
      if ((e.key === 'f' || e.key === 'F') && !isEditingText && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        setIsFullscreen((prev) => !prev);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen, isEditingText]);

  // Extract clean HTML from iframe (stripping edit markers)
  const extractCleanHtml = useCallback((): string => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return withPresentationTypography(rawHtmlRef.current);

    const clone = doc.documentElement.cloneNode(true) as HTMLElement;

    // Remove editing stylesheet & floating toolbar
    const editStyle = clone.querySelector('#bob-deck-edit-style');
    if (editStyle) editStyle.remove();
    clone.querySelectorAll('#bob-object-edit-style').forEach(el => el.remove());
    clone.querySelectorAll('[data-bob-selected]').forEach(el => el.removeAttribute('data-bob-selected'));
    const floatBar = clone.querySelector('#bob-floating-toolbar');
    if (floatBar) floatBar.remove();

    // Remove injected autofit and nav fix helpers before saving
    const autoFitScript = clone.querySelector('#bob-autofit-script');
    if (autoFitScript) autoFitScript.remove();
    const navFix = clone.querySelector('#bob-nav-fix-style');
    if (navFix) navFix.remove();

    // Remove contenteditable attributes
    clone.querySelectorAll('[contenteditable]').forEach((el) => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
    });

    return withPresentationTypography(restorePresentationSource(`<!DOCTYPE html>\n<html lang="en">\n${clone.innerHTML}\n</html>`));
  }, []);

  // Scan slides from iframe DOM
  const refreshSlideList = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    const slideEls = doc.querySelectorAll('.slide');
    if (slideEls.length === 0) return;

    const list: SlideItem[] = [];
    let currentIdx = 0;

    slideEls.forEach((slide, idx) => {
      const style = window.getComputedStyle(slide);
      const isAct =
        slide.classList.contains('active') ||
        (Number.parseFloat(style.opacity) > 0.5 && style.visibility !== 'hidden');
      if (isAct) currentIdx = idx;

      const kickerEl = slide.querySelector('.kicker, .chip, .badge');
      const titleEl = slide.querySelector('h1, h2, h3, .title, .display');
      const descEl = slide.querySelector('p.lede, p.sub, p');

      list.push({
        index: idx,
        id: slide.id || `slide-${idx + 1}`,
        title: titleEl?.textContent?.trim() || (slide as HTMLElement).dataset.title || `Slide ${idx + 1}`,
        kicker: kickerEl?.textContent?.trim() || '',
        previewText: descEl?.textContent?.slice(0, 70).trim() || '',
      });
    });

    setSlides(list);
    setActiveSlideIndex(currentIdx);
  }, []);

  // Jump to specific slide
  const goToSlide = (targetIndex: number, automatic = false) => {
    if (!automatic) setFollowNewSlides(false);
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow as any;
    if (!doc || !win) return;

    // Check if deck has a custom goTo function
    if (typeof win.goTo === 'function') {
      try { win.goTo(targetIndex); } catch { /* Fallback below */ }
    } else if (typeof win.goSlide === 'function') {
      const diff = targetIndex - activeSlideIndex;
      try { win.goSlide(diff); } catch { /* Fallback below */ }
    }

    // Direct DOM activation: if custom goTo did not activate the target slide (e.g. stale slide count closure),
    // force active class and visibility directly on the slide DOM elements so every slide is accessible:
    const slideEls = Array.from(doc.querySelectorAll('.slide'));
    const isTargetActive = slideEls[targetIndex]?.classList.contains('active');
    if (!isTargetActive && slideEls[targetIndex]) {
      slideEls.forEach((s, idx) => {
        if (idx === targetIndex) {
          s.classList.add('active');
          (s as HTMLElement).style.opacity = '1';
          (s as HTMLElement).style.visibility = 'visible';
          (s as HTMLElement).style.pointerEvents = 'all';
          if ((s as HTMLElement).style.display === 'none') (s as HTMLElement).style.display = 'flex';
        } else {
          s.classList.remove('active');
          (s as HTMLElement).style.opacity = '0';
          (s as HTMLElement).style.visibility = 'hidden';
          (s as HTMLElement).style.pointerEvents = 'none';
        }
      });
      const dots = doc.querySelectorAll('#dots .dot, .dots .dot');
      dots.forEach((dot, idx) => dot.classList.toggle('active', idx === targetIndex));
    }

    // Trigger chart resize on any canvas in the newly activated slide
    const targetSlide = slideEls[targetIndex];
    if (targetSlide) {
      targetSlide.querySelectorAll('canvas').forEach(canvas => {
        for (const key of Object.keys(win)) {
          try {
            if (win[key] && typeof win[key].resize === 'function' && win[key].canvas === canvas) {
              win[key].resize();
              win[key].update();
            }
          } catch {}
        }
      });
    }

    setActiveSlideIndex(targetIndex);
    setTimeout(refreshSlideList, 250);
  };

  const handlePrevSlide = () => {
    if (activeSlideIndex > 0) goToSlide(activeSlideIndex - 1);
  };

  const handleNextSlide = () => {
    if (activeSlideIndex < slides.length - 1) goToSlide(activeSlideIndex + 1);
  };

  // Add a new slide to the deck
  const handleAddNewSlide = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const deck = doc.getElementById('deck') || doc.body;

    const newSlideIndex = slides.length + 1;
    const newSection = doc.createElement('section');
    newSection.className = 'slide';
    newSection.id = `s${newSlideIndex}`;
    newSection.setAttribute('data-title', `Slide ${newSlideIndex}`);

    newSection.innerHTML = `
      <div class="inner slide-inner" style="max-width: 1300px; margin: 0 auto; width: 100%;">
        <p class="kicker" style="color: var(--muted); font-size: 0.95rem; margin-bottom: 0.8rem; font-weight: 600;">NEW TOPIC</p>
        <h2 class="title display" style="font-size: 2.6rem; font-weight: 700; margin-bottom: 1.2rem; color: var(--text);">Executive Topic Header</h2>
        <p class="lede sub" style="font-size: 1.15rem; color: var(--muted); margin-bottom: 2rem; max-width: 60ch;">Click any text in Edit Mode to customize this slide with findings, architecture diagrams, or operational metrics.</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1.5rem;">
          <div style="background: var(--surface); border: 1px solid var(--line, rgba(148,163,184,0.2)); border-radius: 12px; padding: 1.5rem;">
            <strong style="color: var(--brand-primary, #a63bff); font-size: 1.2rem; display: block; margin-bottom: 0.5rem;">Key Initiative 01</strong>
            <p style="color: var(--muted); font-size: 0.95rem; line-height: 1.5;">Describe the operational priority, deliverable status, and strategic milestone impact.</p>
          </div>
          <div style="background: var(--surface); border: 1px solid var(--line, rgba(148,163,184,0.2)); border-radius: 12px; padding: 1.5rem;">
            <strong style="color: var(--brand-secondary, #ff7a1a); font-size: 1.2rem; display: block; margin-bottom: 0.5rem;">Governance Target 02</strong>
            <p style="color: var(--muted); font-size: 0.95rem; line-height: 1.5;">Automated enforcement criteria, compliance readiness metrics, and risk mitigation.</p>
          </div>
          <div style="background: var(--surface); border: 1px solid var(--line, rgba(148,163,184,0.2)); border-radius: 12px; padding: 1.5rem;">
            <strong style="color: #4ade95; font-size: 1.2rem; display: block; margin-bottom: 0.5rem;">Efficiency Gain 03</strong>
            <p style="color: var(--muted); font-size: 0.95rem; line-height: 1.5;">Quantified cost reduction, lineage verification, and knowledge catalog operational outcomes.</p>
          </div>
        </div>
      </div>
    `;

    deck.appendChild(newSection);

    // Refresh slides and jump to new slide
    refreshSlideList();
    goToSlide(slides.length);
    setIsDirty(true);
    if (isEditingText) applyEditModeToIframe(true);
  };

  // Duplicate current active slide
  const handleDuplicateSlide = (idxToDup: number) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const slideEls = doc.querySelectorAll('.slide');
    const targetSlide = slideEls[idxToDup];
    if (!targetSlide) return;

    const clone = targetSlide.cloneNode(true) as HTMLElement;
    clone.id = `slide-${Date.now()}`;
    targetSlide.after(clone);

    refreshSlideList();
    goToSlide(idxToDup + 1);
    setIsDirty(true);
    if (isEditingText) applyEditModeToIframe(true);
  };

  useEffect(() => {
    if (isWorking && followNewSlides && slides.length) goToSlide(slides.length - 1, true);
  }, [slides.length, followNewSlides, isWorking]);

  // Delete slide
  const handleDeleteSlide = async (idxToDelete: number) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const slideEls = doc.querySelectorAll('.slide');
    if (slideEls.length <= 1) {
      void appAlert('Cannot delete the only slide in the presentation.');
      return;
    }

    if (!await appConfirm(`Delete Slide ${idxToDelete + 1}?`)) return;

    slideEls[idxToDelete].remove();
    refreshSlideList();
    const nextIdx = Math.max(0, idxToDelete - 1);
    goToSlide(nextIdx);
    setIsDirty(true);
  };

  // Move slide up / down
  const handleMoveSlide = (fromIdx: number, direction: 'up' | 'down') => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const slideEls = [...doc.querySelectorAll('.slide')];
    const targetIdx = direction === 'up' ? fromIdx - 1 : fromIdx + 1;
    if (targetIdx < 0 || targetIdx >= slideEls.length) return;

    const currentSlideEl = slideEls[fromIdx];
    const adjacentSlideEl = slideEls[targetIdx];

    if (direction === 'up') {
      adjacentSlideEl.before(currentSlideEl);
    } else {
      adjacentSlideEl.after(currentSlideEl);
    }

    refreshSlideList();
    goToSlide(targetIdx);
    setIsDirty(true);
  };

  // Scan charts and metrics in current deck
  const scanChartsAndMetrics = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow as any;
    if (!doc) return;

    const items: ChartItem[] = [];

    // 1. Detect Chart.js instances if exposed on window
    ['chartGovernancePillars', 'chartCompliance', 'chart1', 'chart2'].forEach((key) => {
      const c = win?.[key];
      if (c && c.data) {
        items.push({
          id: key,
          name: key.replace(/^chart/, '').replace(/([A-Z])/g, ' $1').trim() || key,
          type: c.config?.type || 'chart',
          labels: [...(c.data.labels || [])],
          values: [...(c.data.datasets?.[0]?.data || [])],
        });
      }
    });

    // 2. Detect stat numbers on slide
    const statEls = doc.querySelectorAll('.stat .num, .num[data-count]');
    if (statEls.length > 0 && items.length === 0) {
      const labels: string[] = [];
      const values: number[] = [];
      statEls.forEach((el, idx) => {
        const parent = el.closest('.stat') || el.parentElement;
        const lbl = parent?.querySelector('.label')?.textContent?.trim() || `Metric ${idx + 1}`;
        const numVal = Number.parseFloat(el.textContent?.replace(/[^0-9.]/g, '') || '0');
        labels.push(lbl);
        values.push(numVal);
      });
      items.push({
        id: 'kpi_metrics',
        name: 'Executive Key Metrics',
        type: 'kpi',
        labels,
        values,
      });
    }

    setDetectedCharts(items);
  }, []);

  // Apply chart data changes
  const applyChartData = (chartId: string, updatedLabels: string[], updatedValues: number[]) => {
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow as any;
    if (!doc) return;

    const c = win?.[chartId];
    if (c && c.data) {
      c.data.labels = updatedLabels;
      if (c.data.datasets?.[0]) {
        c.data.datasets[0].data = updatedValues;
      }
      c.update();
    } else if (chartId === 'kpi_metrics') {
      const statEls = doc.querySelectorAll('.stat .num, .num[data-count]');
      statEls.forEach((el, idx) => {
        if (updatedValues[idx] !== undefined) {
          el.textContent = String(updatedValues[idx]);
          el.setAttribute('data-count', String(updatedValues[idx]));
        }
      });
    }

    setIsDirty(true);
    setShowDataModal(false);
  };

  // Setup text editing and floating formatting toolbar in iframe
  const applyEditModeToIframe = useCallback((enable: boolean) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    let styleTag = doc.getElementById('bob-deck-edit-style');
    let toolbarEl = doc.getElementById('bob-floating-toolbar');

    if (enable) {
      if (!styleTag) {
        styleTag = doc.createElement('style');
        styleTag.id = 'bob-deck-edit-style';
        styleTag.textContent = `
          [contenteditable="true"] {
            outline: 1.5px dashed rgba(166, 59, 255, 0.55) !important;
            outline-offset: 4px !important;
            border-radius: 4px !important;
            cursor: text !important;
            transition: all 0.15s ease !important;
          }
          [contenteditable="true"]:hover {
            outline: 1.5px dashed #a63bff !important;
            background: rgba(166, 59, 255, 0.1) !important;
          }
          [contenteditable="true"]:focus {
            outline: 2px solid #ff7a1a !important;
            background: rgba(255, 122, 26, 0.15) !important;
          }
          #bob-floating-toolbar {
            position: absolute;
            z-index: 100000;
            display: none;
            background: #180d2e;
            border: 1px solid #7c3aed;
            border-radius: 8px;
            padding: 4px 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.6);
            align-items: center;
            gap: 4px;
          }
          #bob-floating-toolbar button {
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.15);
            color: #ffffff;
            border-radius: 4px;
            padding: 3px 8px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
          }
          #bob-floating-toolbar button:hover {
            background: #7c3aed;
          }
        `;
        doc.head.appendChild(styleTag);
      }

      // Add floating toolbar if missing
      if (!toolbarEl) {
        toolbarEl = doc.createElement('div');
        toolbarEl.id = 'bob-floating-toolbar';
        toolbarEl.innerHTML = `
          <button type="button" data-cmd="bold" title="Bold"><strong>B</strong></button>
          <button type="button" data-cmd="italic" title="Italic"><em>I</em></button>
          <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
          <button type="button" data-color="#a63bff" title="Purple accent" style="color: #c084fc;">●</button>
          <button type="button" data-color="#ff7a1a" title="Orange accent" style="color: #ff7a1a;">●</button>
          <button type="button" data-color="#4ade95" title="Green accent" style="color: #4ade95;">●</button>
          <button type="button" data-cmd="insertUnorderedList" title="Bullet List">• List</button>
          <button type="button" data-cmd="removeFormat" title="Clear Formatting">✕</button>
        `;
        doc.body.appendChild(toolbarEl);

        toolbarEl.querySelectorAll('button').forEach((btn) => {
          btn.onmousedown = (e) => {
            e.preventDefault();
            const cmd = btn.getAttribute('data-cmd');
            const col = btn.getAttribute('data-color');
            if (cmd) {
              doc.execCommand(cmd, false, undefined);
            } else if (col) {
              doc.execCommand('foreColor', false, col);
            }
            setIsDirty(true);
          };
        });
      }

      // Selection tracking for floating toolbar
      doc.onselectionchange = () => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed || !toolbarEl) {
          if (toolbarEl) toolbarEl.style.display = 'none';
          return;
        }
        try {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0) {
            toolbarEl.style.display = 'flex';
            toolbarEl.style.top = `${Math.max(10, rect.top + doc.defaultView!.scrollY - 44)}px`;
            toolbarEl.style.left = `${Math.max(10, rect.left + doc.defaultView!.scrollX)}px`;
          }
        } catch {}
      };

      // Set contenteditable on text elements
      const editableSelectors = [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', '.kicker', '.lede', '.sub', '.title', '.display',
        '.num', '.label', '.tag', '.stat-val', '.stat-lbl',
        '.card-title', '.card-desc', 'li', 'span.accent', 'span.accent-blue',
        '.agenda-item .label', 'td', 'th', '.pill'
      ].join(', ');

      const elements = doc.querySelectorAll(editableSelectors);
      elements.forEach((el) => {
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('spellcheck', 'false');
        (el as HTMLElement).oninput = () => {
          setIsDirty(true);
        };
      });
    } else {
      if (styleTag) styleTag.remove();
      if (toolbarEl) toolbarEl.remove();
      doc.onselectionchange = null;
      doc.querySelectorAll('[contenteditable]').forEach((el) => {
        el.removeAttribute('contenteditable');
        el.removeAttribute('spellcheck');
        (el as HTMLElement).oninput = null;
      });
    }
  }, []);

  // Toggle Text Editing
  const toggleTextEditing = () => {
    setSelectingObjects(false);
    chooseObject(null);
    if (isEditingText) {
      const cleaned = extractCleanHtml();
      rawHtmlRef.current = cleaned;
      applyEditModeToIframe(false);
      setIsEditingText(false);
    } else {
      setIsEditingText(true);
      applyEditModeToIframe(true);
    }
  };

  // Apply colors live to iframe
  const applyColors = (newColors: DeckColors) => {
    setColors(newColors);
    setIsDirty(true);

    const doc = iframeRef.current?.contentDocument;
    if (doc) {
      const root = doc.documentElement;
      root.style.setProperty('--brand-primary', newColors.brandPrimary);
      root.style.setProperty('--brand-secondary', newColors.brandSecondary);
      root.style.setProperty('--brand-blue', newColors.brandBlue);
      root.style.setProperty('--blue', newColors.brandBlue);
      root.style.setProperty('--purple', newColors.brandPrimary);
      root.style.setProperty('--bg', newColors.bg);
      root.style.setProperty('--surface', newColors.surface);
      root.style.setProperty('--text', newColors.text);

      const g1 = doc.querySelector('.glow.g1, .glow.g3') as HTMLElement | null;
      if (g1) g1.style.background = newColors.brandPrimary;
      const g2 = doc.querySelector('.glow.g2') as HTMLElement | null;
      if (g2) g2.style.background = newColors.brandSecondary;
    }

    let updatedHtml = rawHtmlRef.current;
    const colorReplacements: Array<[RegExp, string]> = [
      [/--brand-primary:[^;]+;/gi, `--brand-primary: ${newColors.brandPrimary};`],
      [/--brand-secondary:[^;]+;/gi, `--brand-secondary: ${newColors.brandSecondary};`],
      [/--brand-blue:[^;]+;/gi, `--brand-blue: ${newColors.brandBlue};`],
      [/--bg:[^;]+;/gi, `--bg: ${newColors.bg};`],
      [/--surface:[^;]+;/gi, `--surface: ${newColors.surface};`],
      [/--text:[^;]+;/gi, `--text: ${newColors.text};`],
    ];

    colorReplacements.forEach(([pattern, repl]) => {
      updatedHtml = updatedHtml.replace(pattern, repl);
    });

    rawHtmlRef.current = updatedHtml;
    // Colors were applied directly to the running frame.
  };

  // Save changes back to session/workspace file
  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    setErrorMessage(null);

    try {
      const cleanHtml = extractCleanHtml();
      if (onSaveHtml) await onSaveHtml(cleanHtml);
      else await saveSessionFile(sessionId || 'legacy', filename, cleanHtml);

      // The editable DOM already contains these changes; saving must not reload it.
      setSavedHtml(cleanHtml);
      rawHtmlRef.current = cleanHtml;
      setIsDirty(false);
      setSaveStatus('success');

      setTimeout(() => {
        setSaveStatus('idle');
      }, 3000);
    } catch (err: any) {
      console.error('Failed to save presentation:', err);
      setSaveStatus('error');
      setErrorMessage(err.message || 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  // Revert changes
  const handleRevert = async () => {
    if (!await appConfirm('Revert all unsaved text and color changes?')) return;
    chooseObject(null);
    setRemovedObjects([]);
    setCurrentHtml(savedHtml);
    rawHtmlRef.current = savedHtml;
    setColors(extractColorsFromHtml(savedHtml));
    setIsDirty(false);
    setIsEditingText(false);


  };

  const saveHtmlToOffice = async () => {
    if (htmlOfficeFile && !isDirty) { navigateOffice(`/office/files/${htmlOfficeFile.id}`); return; }
    setSavingHtmlOffice(true); setErrorMessage(null);
    try {
      const html = withPresentationTypography(isDirty ? extractCleanHtml() : savedHtml);
      const form = new FormData();
      form.append('file', new File([html], /\.html?$/i.test(filename) ? filename : `${filename}.html`, {type:'text/html'}));
      const response = await fetch('/api/office/files', {method:'POST', body:form});
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not save HTML to Office Suite.');
      setHtmlOfficeFile({id:result.id,name:result.name});
      // The new library copy owns these edits; keep the source artifact intact.
      navigateOffice(`/office/files/${result.id}`);
    } catch(error) { setErrorMessage((error as Error).message); }
    finally { setSavingHtmlOffice(false); }
  };

  // Download standalone HTML
  const handleDownload = () => {
    const finalHtml = extractCleanHtml();
    const blob = new Blob([finalHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.html') ? filename : `${filename}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const [isUploadingOfficeSuite, setIsUploadingOfficeSuite] = useState(false);
  const [officeSuiteSavedFile, setOfficeSuiteSavedFile] = useState<{ id: string; name: string } | null>(null);

  const handleSavePptxToOfficeSuite = async (openInEditor = false) => {
    try {
      setIsUploadingOfficeSuite(true);
      setErrorMessage(null);
      const doc = iframeRef.current?.contentDocument;
      const extractedSlides: Array<{ id: string; kicker: string; title: string; bodyText: string; cards: Array<{ heading: string; body: string }> }> = [];
      if (doc) {
        doc.querySelectorAll('.slide').forEach((slide, idx) => {
          const kicker = slide.querySelector('.kicker, .chip, .badge')?.textContent?.trim() || '';
          const slideTitle = slide.querySelector('h1, h2, h3, .title, .display')?.textContent?.trim() || `Slide ${idx + 1}`;
          const cardEls = slide.querySelectorAll('.card, .step-card, [class*="card"]');
          const cards: Array<{ heading: string; body: string }> = [];
          cardEls.forEach(c => {
            const h = c.querySelector('strong, h3, h4, .card-title, .num, .stat-val')?.textContent?.trim() || '';
            const b = Array.from(c.querySelectorAll('p, li, .card-desc, .step-detail, .label, .stat-lbl')).map(x => x.textContent?.trim()).filter(Boolean).join('\n');
            if (h || b) cards.push({ heading: h, body: b });
          });
          const bodyText = Array.from(slide.querySelectorAll('p, li')).map(p => p.textContent?.trim()).filter(Boolean).slice(0, 8).join('\n• ');
          extractedSlides.push({ id: slide.id || `slide-${idx + 1}`, kicker, title: slideTitle, bodyText, cards });
        });
      }
      const fallbackSlides = slides.map(s => ({ id: s.id, kicker: s.kicker, title: s.title, bodyText: s.previewText, cards: [] }));
      const blob = await buildHtmlDeckPptxBlob({
        title: displayTitle,
        slides: extractedSlides.length > 0 ? extractedSlides : fallbackSlides,
        colors,
      });
      const safeBase = displayTitle.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Presentation';
      const pptxName = safeBase.toLowerCase().endsWith('.pptx') ? safeBase : `${safeBase}.pptx`;
      const file = new File([blob], pptxName, {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/office/files', { method: 'POST', body: formData });
      if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(typeof detail.detail === 'string' ? detail.detail : 'Could not upload PowerPoint to Office Suite.');
      }
      const savedFile = await response.json();
      setOfficeSuiteSavedFile({ id: savedFile.id, name: savedFile.name });
      if (openInEditor && savedFile?.id) {
        if (document.fullscreenElement) {
          await document.exitFullscreen().catch(() => {});
        }
        navigateOffice(`/office/files/${savedFile.id}`);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save PowerPoint to Office Suite');
    } finally {
      setIsUploadingOfficeSuite(false);
    }
  };

  // Open in new tab
  const handleOpenNewTab = () => {
    const finalHtml = extractCleanHtml();
    const blob = new Blob([finalHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const wrapper = new Blob([sandboxedPresentationPage(url)], { type: 'text/html;charset=utf-8' });
    const wrapperUrl = URL.createObjectURL(wrapper);
    window.open(wrapperUrl, '_blank', 'noopener,noreferrer');
  };

  // Toggle Fullscreen
  const toggleFullscreen = () => {
    const next = !isFullscreen;
    setIsFullscreen(next);
    if (!containerRef.current) return;
    if (next) {
      if (containerRef.current.requestFullscreen && !document.fullscreenElement) {
        containerRef.current.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  // On iframe load: sync slide list, scan charts, inject high-contrast nav styles
  const handleIframeLoad = () => {
    typingCleanup.current?.();
    const frameWindow = iframeRef.current?.contentWindow;
    if (frameWindow) typingCleanup.current = protectPresentationTyping(frameWindow);
    setFrameVersion(version => version + 1);
    const doc = iframeRef.current?.contentDocument;
    if (doc) {
      doc.addEventListener('buddy-html-edited', () => setIsDirty(true));
      if (frameHtml !== currentHtml) syncPresentationDocument(doc, sanitizeEditablePresentation(withPresentationTypography(currentHtml)));
      // Inject high-contrast styles for navigation buttons so they are always visible
      const navFix = doc.createElement('style');
      navFix.textContent = `
        /* Top right floating buttons (Fullscreen, Shortcuts, Edit) */
        #ui-buttons {
          position: fixed !important;
          top: 1.2rem !important;
          right: 1.4rem !important;
          z-index: 9999 !important;
          display: flex !important;
          gap: 8px !important;
          align-items: center !important;
        }
        .ui-btn {
          min-width: 38px !important;
          height: 38px !important;
          padding: 0 12px !important;
          border-radius: 999px !important;
          border: 1.5px solid rgba(148, 163, 184, 0.45) !important;
          background: rgba(15, 23, 42, 0.95) !important;
          color: #ffffff !important;
          font-size: 0.85rem !important;
          font-weight: 700 !important;
          cursor: pointer !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 6px !important;
          backdrop-filter: blur(16px) !important;
          -webkit-backdrop-filter: blur(16px) !important;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
          transition: all 0.18s ease !important;
        }
        .ui-btn:hover {
          border-color: #38bdf8 !important;
          background: #1e293b !important;
          color: #38bdf8 !important;
          transform: translateY(-1px) !important;
          box-shadow: 0 6px 20px rgba(56, 189, 248, 0.35) !important;
        }
        .ui-btn svg {
          stroke: #ffffff !important;
        }

        /* Bottom slide navigation pill */
        #nav {
          background: rgba(15, 23, 42, 0.96) !important;
          border: 1.5px solid rgba(148, 163, 184, 0.5) !important;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7) !important;
        }
        #nav button {
          width: 40px !important;
          height: 40px !important;
          background: rgba(255, 255, 255, 0.2) !important;
          color: #ffffff !important;
          font-weight: 800 !important;
          font-size: 1.25rem !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          border-radius: 50% !important;
          transition: all 0.18s ease !important;
        }
        #nav button:hover {
          background: #3b82f6 !important;
          color: #ffffff !important;
          transform: scale(1.08) !important;
        }
        #slide-counter {
          color: #ffffff !important;
          font-weight: 700 !important;
          font-size: 0.92rem !important;
        }
        .dot {
          background: rgba(255, 255, 255, 0.4) !important;
        }
        .dot.on {
          background: #38bdf8 !important;
          transform: scale(1.3) !important;
        }

        /* Slide 10 Stepper & Chevrons */
        .step-chevron {
          color: #38bdf8 !important;
          font-size: 1.15rem !important;
          opacity: 1 !important;
          font-weight: 800 !important;
        }
        .step-card {
          border: 1.5px solid rgba(148, 163, 184, 0.35) !important;
          background: var(--surface) !important;
          box-shadow: 0 4px 14px rgba(0,0,0,0.1) !important;
        }
        .step-card:hover {
          border-color: #38bdf8 !important;
        }

        /* Toggle & Filter Buttons */
        .toggle-btn, .chart-filter, .q-dim-btn {
          border: 1.5px solid rgba(148, 163, 184, 0.4) !important;
          color: var(--text) !important;
          background: var(--surface2) !important;
          font-weight: 600 !important;
        }
        .toggle-btn.active, .chart-filter.active, .q-dim-btn.active {
          background: #2563eb !important;
          color: #ffffff !important;
          border-color: #3b82f6 !important;
          box-shadow: 0 2px 10px rgba(37, 99, 235, 0.4) !important;
        }

        /* Side navigation zones */
        .nav-zone .chev {
          opacity: 0.85 !important;
          border: 2px solid rgba(166, 59, 255, 0.7) !important;
          background: rgba(28, 16, 48, 0.92) !important;
        }
        .nav-zone:hover .chev {
          opacity: 1 !important;
          background: rgba(166, 59, 255, 0.35) !important;
        }

        /* ─── Laptop & Compact Display Parity (max-height <= 860px) ─── */
        @media (max-height: 860px), (max-width: 1100px) {
          .slide {
            padding: clamp(0.7rem, calc(2vh / var(--ui-scale, 1)), 1.6rem) clamp(1.2rem, calc(3.5vw / var(--ui-scale, 1)), 2.8rem) 3.6rem !important;
            justify-content: flex-start !important;
          }
          h1.hero {
            font-size: clamp(1.8rem, calc(4vh / var(--ui-scale, 1)), 2.8rem) !important;
            margin: 0.3rem 0 0.5rem !important;
          }
          h2.title {
            font-size: clamp(1.25rem, calc(3.2vh / var(--ui-scale, 1)), 1.85rem) !important;
            margin: 0.2rem 0 0.5rem !important;
          }
          .sub {
            font-size: clamp(0.82rem, calc(1.8vh / var(--ui-scale, 1)), 0.95rem) !important;
            margin-bottom: 0.75rem !important;
            line-height: 1.45 !important;
          }
          .role-table {
            font-size: 0.8rem !important;
          }
          .role-table th {
            padding: 0.38rem 0.6rem !important;
            font-size: 0.72rem !important;
          }
          .role-table td {
            padding: 0.32rem 0.6rem !important;
          }
          .role-filter-row {
            margin-bottom: 0.6rem !important;
          }
          .role-filter-btn {
            padding: 0.2rem 0.6rem !important;
            font-size: 0.75rem !important;
          }
          .step-card {
            padding: 0.55rem 0.85rem !important;
            gap: 0.8rem !important;
          }
          .step-icon {
            font-size: 1.4rem !important;
          }
          .step-detail {
            font-size: 0.82rem !important;
          }
          .card {
            padding: 0.75rem 0.95rem !important;
          }
          .grid-2, .grid-3, .grid-4 {
            gap: 0.8rem !important;
          }
          #nav {
            bottom: 0.8rem !important;
            padding: 0.35rem 0.65rem !important;
          }
          #nav button {
            width: 32px !important;
            height: 32px !important;
            font-size: 1rem !important;
          }
          #slide-counter {
            font-size: 0.8rem !important;
          }
        }

        @media (max-height: 700px) {
          .slide {
            padding: 0.4rem clamp(1rem, calc(3vw / var(--ui-scale, 1)), 2rem) 3.2rem !important;
          }
          h2.title {
            font-size: 1.15rem !important;
            margin: 0.15rem 0 0.35rem !important;
          }
          .role-table th, .role-table td {
            padding: 0.22rem 0.5rem !important;
            font-size: 0.72rem !important;
          }
        }
      `;
      if (!doc.head.querySelector('#bob-nav-fix-style')) {
        navFix.id = 'bob-nav-fix-style';
        doc.head.appendChild(navFix);
      }

      // Auto-fit script: safely scales slide content proportionally to guarantee 100% visibility on all screens
      // Crucial: Only observe 'class' changes with an isFitting guard to prevent infinite layout recursion
      if (!doc.body.querySelector('#bob-autofit-script')) {
        const autoFitScript = doc.createElement('script');
        autoFitScript.id = 'bob-autofit-script';
        autoFitScript.textContent = `
          (function() {
            let isFitting = false;
            function autoFitSlide() {
              if (isFitting) return;
              const activeSlide = document.querySelector('.slide.active');
              if (!activeSlide) return;
              const inner = activeSlide.querySelector('.inner, .slide-inner');
              if (!inner) return;

              isFitting = true;
              requestAnimationFrame(function() {
                try {
                  inner.style.transform = 'none';
                  inner.style.transformOrigin = 'top center';
                  inner.style.width = '100%';

                  const windowH = window.innerHeight;
                  const availH = windowH - 68;
                  const contentH = inner.scrollHeight;

                  if (contentH > availH && availH > 200) {
                    const scale = Math.max(0.62, Math.min(1, availH / contentH));
                    inner.style.transform = 'scale(' + scale + ')';
                    inner.style.transformOrigin = 'top center';
                    inner.style.width = (100 / scale) + '%';
                  }
                } finally {
                  setTimeout(function() { isFitting = false; }, 60);
                }
              });
            }
            window.addEventListener('resize', autoFitSlide);
            const deck = document.getElementById('deck') || document.body;
            const observer = new MutationObserver(function(mutations) {
              if (isFitting) return;
              for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].attributeName === 'class') {
                  autoFitSlide();
                  break;
                }
              }
            });
            observer.observe(deck, { attributes: true, subtree: true, attributeFilter: ['class'] });
            setTimeout(autoFitSlide, 100);
          })();
        `;
        doc.body.appendChild(autoFitScript);
      }
    }

    refreshSlideList();
    scanChartsAndMetrics();
    if (isEditingText) {
      applyEditModeToIframe(true);
    }
  };

  // Generation checks apply to generated artifacts, not saved Office Studio uploads.
  if (shouldWaitForHtmlDeck(currentHtml, isWorking, officeFileId)) {
    return (
      <div
        className="bobdeck-viewer html-deck-viewer incomplete-presentation-state"
        style={{
          marginTop: '14px',
          marginBottom: '16px',
          borderRadius: '14px',
          border: '1px solid rgba(245, 158, 11, 0.4)',
          background: 'linear-gradient(180deg, #1d0f33 0%, #110722 100%)',
          padding: '28px 32px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '14px',
          color: '#f8fafc',
        }}
      >
        <div style={{ fontSize: '38px', filter: 'drop-shadow(0 4px 12px rgba(245, 158, 11, 0.45))' }}>
          ⏳
        </div>
        <div>
          <h4 style={{ margin: '0 0 8px', fontSize: '17px', fontWeight: 700, color: '#fcd34d' }}>
            {t("Presentation Generation Incomplete")}</h4>
          <p style={{ margin: 0, fontSize: '13px', color: '#cbd5e1', maxWidth: '520px', lineHeight: 1.6 }}>
            {t("This presentation file is still being generated or was interrupted before completion. The interactive slide studio will not open until all slides and markup are fully generated.")}</p>
        </div>
        <button
          type="button"
          onClick={() => setReloadCounter((c) => c + 1)}
          style={{
            marginTop: '6px',
            padding: '8px 20px',
            borderRadius: '8px',
            background: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)',
            border: 'none',
            color: '#ffffff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(124, 58, 237, 0.35)',
          }}
        >
          {t("↻ Check Again")}</button>
      </div>
    );
  }

  // If fetching the presentation failed or file does not exist, do not display a stuck loader
  if (loadFailed) {
    return null;
  }

  // Loading state while fetching presentation content from disk
  if (!currentHtml && filename) {
    return (
      <div
        className="bobdeck-viewer html-deck-viewer loading-presentation-state"
        style={{
          marginTop: '14px',
          marginBottom: '16px',
          borderRadius: '14px',
          border: '1px solid #30224a',
          background: 'linear-gradient(180deg, #1b0f2e 0%, #110722 100%)',
          padding: '24px 28px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '12px',
          color: '#cbd5e1',
        }}
      >
        <div className="bobdeck-spinner" style={{ fontSize: '28px' }}>📊</div>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}>
          {t("Loading presentation:")}{filename}…
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`bobdeck-viewer html-deck-viewer ${isFullscreen ? 'fullscreen' : ''}`}
      style={{
        position: isFullscreen ? 'fixed' : 'relative',
        top: isFullscreen ? 0 : 'auto',
        left: isFullscreen ? 0 : 'auto',
        right: isFullscreen ? 0 : 'auto',
        bottom: isFullscreen ? 0 : 'auto',
        zIndex: isFullscreen ? 99999 : 'auto',
        marginTop: isFullscreen ? 0 : '14px',
        marginBottom: isFullscreen ? 0 : '16px',
        borderRadius: isFullscreen ? 0 : '14px',
        border: isFullscreen ? 'none' : "1px solid #30224a",
        background: '#0d0818',
        overflow: 'hidden',
        boxShadow: isFullscreen ? 'none' : "0 8px 32px rgba(0, 0, 0, 0.45)",
        display: 'flex',
        flexDirection: 'column',
        width: isFullscreen ? 'calc(100vw / var(--ui-scale, 1))' : '100%',
        height: isFullscreen ? 'calc(100vh / var(--ui-scale, 1))' : 'auto',
      }}
    >
      {/* ─── High-Contrast PowerPoint-Grade Top Studio Toolbar ─── */}
      <Toolbar
        className="bobdeck-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 18px',
          background: 'linear-gradient(180deg, #1b0e33 0%, #110722 100%)',
          borderBottom: '2px solid #5b1f8a',
          zIndex: 20,
          position: 'sticky',
          top: 0,
          flexWrap: 'wrap',
          gap: '10px',
        }}
      >
        {/* Left: Brand Pill, Title, Slide Filmstrip Toggle, Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 800,
              padding: '4px 10px',
              borderRadius: '999px',
              background: 'linear-gradient(135deg, rgba(166, 59, 255, 0.3) 0%, rgba(255, 122, 26, 0.25) 100%)',
              color: '#f5f3ff',
              border: '1px solid #a63bff',
              letterSpacing: '0.05em',
            }}
          >
            {t("⚡ PRESENTATION STUDIO")}</span>

          <strong
            style={{
              fontSize: '14px',
              color: '#ffffff',
              fontWeight: 700,
              maxWidth: '280px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={displayTitle}
          >
            {displayTitle}
          </strong>

          {/* Slide Navigation & Jump */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1.5px solid rgba(166, 59, 255, 0.5)',
              borderRadius: '8px',
              padding: '3px 6px',
              gap: '6px',
            }}
          >
            <button
              type="button"
              onClick={handlePrevSlide}
              disabled={activeSlideIndex <= 0}
 title={t("Previous slide (←)")} style={{
                background: 'transparent',
                border: 'none',
                color: activeSlideIndex <= 0 ? '#64748b' : '#ffffff',
                cursor: activeSlideIndex <= 0 ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: 700,
                padding: '2px 6px',
              }}
            >
              ◀
            </button>
            <span style={{ fontSize: '11.5px', color: '#f5f3ff', fontWeight: 700 }}>
              {t("Slide")}{activeSlideIndex + 1} / {slides.length || 1}
            </span>
            <button
              type="button"
              onClick={handleNextSlide}
              disabled={activeSlideIndex >= slides.length - 1}
 title={t("Next slide (→)")} style={{
                background: 'transparent',
                border: 'none',
                color: activeSlideIndex >= slides.length - 1 ? '#64748b' : '#ffffff',
                cursor: activeSlideIndex >= slides.length - 1 ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                fontWeight: 700,
                padding: '2px 6px',
              }}
            >
              ▶
            </button>
          </div>

          {/* Toggle Filmstrip */}
          <button
            type="button"
            onClick={() => setShowFilmstrip(!showFilmstrip)}
            title={t("Toggle Slide Filmstrip Sidebar")}
            style={{
              background: showFilmstrip ? "rgba(59, 130, 246, 0.25)" : "rgba(255, 255, 255, 0.06)",
              border: `1px solid ${showFilmstrip ? '#3b82f6' : '#475569'}`,
              color: showFilmstrip ? '#60a5fa' : '#cbd5e1',
              padding: '5px 10px',
              borderRadius: '8px',
              fontSize: '11.5px',
              fontWeight: 650,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <span>📋</span>
            <span>{showFilmstrip ? t("Hide Slides") : t("Show Slides")}</span>
          </button>
        </div>

        {isWorking && <label role="status" style={{ color: '#cbd5e1', fontSize: '12px' }}>
          {slides.length} {t("slides written")}<input type="checkbox" checked={followNewSlides} onChange={event => setFollowNewSlides(event.target.checked)} /> {t("Follow new slides")}</label>}
        {/* Right: Studio Editing Actions (High Contrast & Visible) */}
        <div inert={isWorking} aria-disabled={isWorking} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', opacity: isWorking ? 0.55 : 1 }}>
          {/* Edit Text Button */}
          <button
            type="button"
            onClick={toggleTextEditing}
            title={t("Click to edit any text directly on the slide")}
            style={{
              background: isEditingText
                ? "linear-gradient(135deg, #a63bff 0%, #7b00e0 100%)"
                : '#231245',
              border: `1.5px solid ${isEditingText ? '#c084fc' : '#8b5cf6'}`,
              color: '#ffffff',
              padding: '6px 13px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: isEditingText ? "0 0 14px rgba(166, 59, 255, 0.6)" : 'none',
            }}
          >
            <span>{isEditingText ? '✓' : '✏️'}</span>
            <span>{isEditingText ? t("Done Editing") : t("Edit Text")}</span>
          </button>

 <button type="button" className="studio-object-button" title={t("Select text, frames, images, or charts on the slide")} aria-pressed={selectingObjects} onClick={() => {
            if (isEditingText) { applyEditModeToIframe(false); setIsEditingText(false); }
            setSelectingObjects(value => !value);
          }}><span aria-hidden="true">⌖</span> {t("Select objects")}</button>
          {selectingObjects && <>
            <span className="studio-object-status" role="status">{selectedObject ? `Selected ${selectedObject.tagName.toLowerCase()}` : t("Click text, a frame, image, or chart")}</span>
            <button type="button" className="studio-object-button studio-object-secondary" disabled={!removablePresentationElement(selectedObject?.parentElement || null)} onClick={() => chooseObject(selectedObject?.parentElement || null)}>{t("Select parent frame")}</button>
            <button type="button" className="studio-object-button studio-object-danger" disabled={!selectedObject} onClick={removeObject}>{t("Delete object")}</button>
          </>}
          {removedObjects.length > 0 && <button type="button" className="studio-object-button studio-object-secondary" onClick={undoRemoval}>{t("Undo removal")}</button>}

          {/* Colors Button */}
          <button
            type="button"
            onClick={() => setShowColorPanel(!showColorPanel)}
            title={t("Customize theme, background, and brand colors")}
            style={{
              background: showColorPanel
                ? "linear-gradient(135deg, #ff7a1a 0%, #d95d00 100%)"
                : '#30180a',
              border: `1.5px solid ${showColorPanel ? '#fed7aa' : '#f97316'}`,
              color: '#ffffff',
              padding: '6px 13px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>🎨</span>
            <span>{t("Colors")}</span>
          </button>

          {/* Edit Chart Data Button */}
          <button
            type="button"
            onClick={() => {
              scanChartsAndMetrics();
              setShowDataModal(true);
            }}
            disabled={livePreview || detectedCharts.length === 0}
            title={t(detectedCharts.length === 0 ? 'Script-based chart data cannot be edited in safe mode. Open the live presentation to view charts.' : 'Edit numbers, percentages, and chart values in an interactive table')}
            style={{
              background: '#082f3a',
              border: '1.5px solid #06b6d4',
              color: '#67e8f9',
              padding: '6px 13px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>📊</span>
            <span>{t("Edit Data")}</span>
          </button>

          {!officeFileId && <ArtifactChangeRequest sessionId={sessionId} path={filename} disabled={isWorking || isDirty || isSaving} />}
          {/* Add Slide Button */}
          <button
            type="button"
            onClick={handleAddNewSlide}
            title={t("Insert a new slide into this presentation")}
            style={{
              background: '#06301d',
              border: '1.5px solid #10b981',
              color: '#6ee7b7',
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <span>➕</span>
            <span>{t("Add Slide")}</span>
          </button>

          {/* Save Button */}
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            title={t("Save changes directly back to file")}
            style={{
              background: isDirty
                ? "linear-gradient(135deg, #22c55e 0%, #15803d 100%)"
                : saveStatus === 'success'
                ? '#14532d'
                : "rgba(255, 255, 255, 0.08)",
              border: `1.5px solid ${isDirty ? '#4ade95' : saveStatus === 'success' ? '#22c55e' : '#475569'}`,
              color: '#ffffff',
              padding: '6px 13px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: isSaving ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: isDirty ? "0 0 12px rgba(34, 197, 94, 0.5)" : 'none',
            }}
          >
            <span>{saveStatus === 'success' ? '✓' : '💾'}</span>
            <span>{isSaving ? t("Saving…") : saveStatus === 'success' ? t("Saved!") : t("Save")}</span>
          </button>

          {/* Reset / Revert Button */}
          {isDirty && (
            <button
              type="button"
              onClick={handleRevert}
              title={t("Discard all unsaved edits")}
              style={{
                background: 'rgba(239, 68, 68, 0.18)',
                border: '1.5px solid #ef4444',
                color: '#fca5a5',
                padding: '6px 10px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 650,
                cursor: 'pointer',
              }}
            >
              {t("↺ Reset")}</button>
          )}


          {!officeFileId && <button className="office-desktop-action" type="button" disabled={savingHtmlOffice || isWorking} onClick={() => void saveHtmlToOffice()}>{t(savingHtmlOffice ? 'Saving HTML to Office Suite…' : htmlOfficeFile && !isDirty ? 'Open HTML in Office Suite' : 'Save HTML to Office Suite')}</button>}
          {/* Save PPTX to Office Suite */}
          <button className="office-desktop-action"
            type="button"
            onClick={() => void handleSavePptxToOfficeSuite(false)}
            disabled={isUploadingOfficeSuite || isWorking}
            title={t("Save as PowerPoint (.pptx) in your personal Office Suite storage")}
            style={{
              background: officeSuiteSavedFile ? '#14532d' : 'linear-gradient(135deg, #6d28d9 0%, #4c1d95 100%)',
              border: `1.5px solid ${officeSuiteSavedFile ? '#22c55e' : '#a78bfa'}`,
              color: '#ffffff',
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: isUploadingOfficeSuite ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <span>☁</span>
            <span>{isUploadingOfficeSuite ? t("Saving PPTX…") : officeSuiteSavedFile ? t("✓ Saved in Office Suite") : t("Save PPTX to Office Suite")}</span>
          </button>

          {/* Open in Office Suite */}
          <button className="office-desktop-action"
            type="button"
            onClick={() => {
              if (officeSuiteSavedFile && !isDirty) {
                navigateOffice(`/office/files/${officeSuiteSavedFile.id}`);
              } else {
                void handleSavePptxToOfficeSuite(true);
              }
            }}
            disabled={isUploadingOfficeSuite || isWorking}
            title={t("Save PowerPoint to Office Suite and open in ONLYOFFICE")}
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid #475569',
              color: '#f1f5f9',
              padding: '6px 11px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: isUploadingOfficeSuite ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <span>▦</span>
            <span>{t("Open in Office Suite")}</span>
          </button>

          {/* Download HTML */}
          <button
            type="button"
            onClick={handleDownload}
            title={t("Download standalone HTML presentation file")}
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid #475569',
              color: '#f1f5f9',
              padding: '6px 11px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <span>📥</span>
            <span>{t("HTML")}</span>
          </button>

          {/* Open In New Tab */}
          <button
            type="button"
            onClick={handleOpenNewTab}
            title={t("Open in new browser tab")}
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid #475569',
              color: '#f1f5f9',
              padding: '6px 9px',
              borderRadius: '8px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            ↗
          </button>

          {/* Fullscreen Toggle (High-contrast, prominent) */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? t("Exit Fullscreen (Esc)") : t("Maximize Presentation to Full Screen (F)")}
            style={{
              background: isFullscreen
                ? "linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)"
                : "linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)",
              border: '2px solid #ffffff',
              color: '#ffffff',
              padding: '7px 16px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 800,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 4px 18px rgba(168, 85, 247, 0.55)',
            }}
          >
            <span style={{ fontSize: '15px' }}>{isFullscreen ? '✕' : '⛶'}</span>
            <span>{isFullscreen ? t("Exit Fullscreen") : 'FULLSCREEN'}</span>
          </button>
        </div>
      </Toolbar>

      {/* Error banner */}
      {errorMessage && (
        <div
          style={{
            background: 'linear-gradient(90deg, #7f1d1d 0%, #991b1b 100%)',
            borderBottom: '2px solid #ef4444',
            padding: '8px 18px',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>⚠️ {errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            style={{ background: 'transparent', border: 'none', color: '#ffffff', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}
          >
            ✕
          </button>
        </div>
      )}

      {officeSuiteSavedFile && !errorMessage && (
        <div className="office-desktop-action"
          role="status"
          style={{
            background: 'linear-gradient(90deg, #14532d 0%, #1e1b4b 100%)',
            borderBottom: '2px solid #22c55e',
            padding: '8px 18px',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <span className="office-desktop-action">☁ {t("Saved \"{0}\" to your personal Office Suite storage.", [officeSuiteSavedFile.name])}</span>
          <button
            type="button"
            className="office-desktop-action" onClick={() => navigateOffice(`/office/files/${officeSuiteSavedFile.id}`)}
            style={{
              background: '#22c55e',
              border: 'none',
              color: '#052e16',
              padding: '4px 12px',
              borderRadius: '6px',
              fontSize: '11.5px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {t("Open in Office Suite →")}
          </button>
        </div>
      )}

      {/* Text Editing Mode Active Banner */}
      {isEditingText && (
        <div
          style={{
            background: 'linear-gradient(90deg, #581c87 0%, #7c2d12 100%)',
            borderBottom: '2px solid #a855f7',
            padding: '8px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12.5px',
            color: '#ffffff',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px' }}>✏️</span>
            <span>
              <strong>{t("Text Edit Mode is Active:")}</strong> {t("Click any title, subtitle, bullet point, or stat on the slide to type. Highlight any text for bold, italic, and color formatting.")}</span>
          </div>
          <button
            type="button"
            onClick={toggleTextEditing}
            style={{
              background: '#ffffff',
              border: 'none',
              color: '#4c1d95',
              padding: '4px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {t("Done Editing")}</button>
        </div>
      )}

      {/* Colors & Themes Drawer */}
      {showColorPanel && (
        <div
          style={{
            background: '#150a24',
            borderBottom: '2px solid #5b1f8a',
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '16px' }}>🎨</span>
              <strong style={{ fontSize: '13px', color: '#ffffff' }}>{t("Visual Theme & Colors")}</strong>
              <small style={{ color: '#c4b5fd', fontSize: '11px' }}>
                {t("(Applies live to all slides and ambient glowing backgrounds)")}</small>
            </div>
            <button
              type="button"
              onClick={() => setShowColorPanel(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#ffffff',
                cursor: 'pointer',
                fontSize: '16px',
                fontWeight: 'bold',
              }}
            >
              ✕
            </button>
          </div>

          {/* Quick Palettes */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 700 }}>{t("Quick Themes:")}</span>
            {COLOR_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => applyColors(preset.colors)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid #475569',
                  borderRadius: '6px',
                  padding: '5px 10px',
                  color: '#ffffff',
                  fontSize: '11.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <span>{preset.icon}</span>
                <span>{preset.name}</span>
                <span
                  style={{
                    display: 'inline-block',
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: preset.colors.brandPrimary,
                    marginLeft: '2px',
                  }}
                />
                <span
                  style={{
                    display: 'inline-block',
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: preset.colors.brandSecondary,
                  }}
                />
              </button>
            ))}
          </div>

          {/* Custom Color Pickers */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: '12px',
            }}
          >
            {/* Primary Accent */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#e2e8f0', fontWeight: 600 }}>
              <span>{t("Primary Brand Color")}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={colors.brandPrimary}
                  onChange={(e) => applyColors({ ...colors, brandPrimary: e.target.value })}
                  style={{ width: '34px', height: '28px', border: '1px solid #ffffff', borderRadius: '4px', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={colors.brandPrimary}
                  onChange={(e) => applyColors({ ...colors, brandPrimary: e.target.value })}
                  style={{ width: '85px', padding: '4px 6px', background: '#0a0514', border: '1px solid #475569', borderRadius: '4px', color: '#ffffff', fontSize: '11px', fontFamily: 'monospace' }}
                />
              </div>
            </label>

            {/* Secondary Accent */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#e2e8f0', fontWeight: 600 }}>
              <span>{t("Secondary Accent")}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={colors.brandSecondary}
                  onChange={(e) => applyColors({ ...colors, brandSecondary: e.target.value })}
                  style={{ width: '34px', height: '28px', border: '1px solid #ffffff', borderRadius: '4px', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={colors.brandSecondary}
                  onChange={(e) => applyColors({ ...colors, brandSecondary: e.target.value })}
                  style={{ width: '85px', padding: '4px 6px', background: '#0a0514', border: '1px solid #475569', borderRadius: '4px', color: '#ffffff', fontSize: '11px', fontFamily: 'monospace' }}
                />
              </div>
            </label>

            {/* Background */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#e2e8f0', fontWeight: 600 }}>
              <span>{t("Slide Background")}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={colors.bg}
                  onChange={(e) => applyColors({ ...colors, bg: e.target.value })}
                  style={{ width: '34px', height: '28px', border: '1px solid #ffffff', borderRadius: '4px', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={colors.bg}
                  onChange={(e) => applyColors({ ...colors, bg: e.target.value })}
                  style={{ width: '85px', padding: '4px 6px', background: '#0a0514', border: '1px solid #475569', borderRadius: '4px', color: '#ffffff', fontSize: '11px', fontFamily: 'monospace' }}
                />
              </div>
            </label>

            {/* Card Surface */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#e2e8f0', fontWeight: 600 }}>
              <span>{t("Card Surface")}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={colors.surface}
                  onChange={(e) => applyColors({ ...colors, surface: e.target.value })}
                  style={{ width: '34px', height: '28px', border: '1px solid #ffffff', borderRadius: '4px', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={colors.surface}
                  onChange={(e) => applyColors({ ...colors, surface: e.target.value })}
                  style={{ width: '85px', padding: '4px 6px', background: '#0a0514', border: '1px solid #475569', borderRadius: '4px', color: '#ffffff', fontSize: '11px', fontFamily: 'monospace' }}
                />
              </div>
            </label>

            {/* Typography */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: '#e2e8f0', fontWeight: 600 }}>
              <span>{t("Typography Color")}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={colors.text}
                  onChange={(e) => applyColors({ ...colors, text: e.target.value })}
                  style={{ width: '34px', height: '28px', border: '1px solid #ffffff', borderRadius: '4px', cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={colors.text}
                  onChange={(e) => applyColors({ ...colors, text: e.target.value })}
                  style={{ width: '85px', padding: '4px 6px', background: '#0a0514', border: '1px solid #475569', borderRadius: '4px', color: '#ffffff', fontSize: '11px', fontFamily: 'monospace' }}
                />
              </div>
            </label>
          </div>
        </div>
      )}

      {!restrictedScripts && <div style={{ padding: '8px 18px', display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button type="button" disabled={!livePreview && isDirty} title={!livePreview && isDirty ? t("Save edits before opening the live presentation") : undefined} onClick={() => setLivePreview(value => !value)}>
          {t(livePreview ? 'Return to editor' : 'Open live presentation')}
        </button>
        <span style={{ fontSize: '12px' }}>{t(livePreview
          ? 'Isolated live presentation. Save edits before reopening; use the presentation’s own navigation.'
          : 'Safe editor: supplied scripts are disabled. Open live presentation for animated charts and interactions.')}</span>
      </div>}
      {/* Main Studio Body: Filmstrip Sidebar + Presentation Stage */}
      <div
        style={{
          display: 'flex',
          flex: '1 1 auto',
          position: 'relative',
          height: isFullscreen ? "calc(calc(100vh / var(--ui-scale, 1)) - 58px)" : "clamp(460px, calc(calc(100vh / var(--ui-scale, 1)) - 210px), 820px)",
          minHeight: '440px',
          overflow: 'hidden',
          background: '#0d0818',
        }}
      >
        {/* ─── Left Slide Filmstrip Sidebar ─── */}
        {showFilmstrip && !livePreview && (
          <aside
            style={{
              width: '240px',
              flex: '0 0 240px',
              background: '#120822',
              borderRight: '1.5px solid #30224a',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
              zIndex: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderBottom: '1px solid #30224a',
                background: '#180d2c',
              }}
            >
              <strong style={{ fontSize: '11px', color: '#c4b5fd', letterSpacing: '0.04em' }}>
                {t("SLIDES (")}{slides.length})
              </strong>
              <button
                type="button"
                onClick={handleAddNewSlide}
                title={t("Add new slide")}
                style={{
                  background: '#10b981',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {t("+ Add")}</button>
            </div>

            {/* Slide Thumbnail Items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px' }}>
              {slides.map((s, idx) => {
                const isActive = idx === activeSlideIndex;
                return (
                  <div
                    key={s.id || idx}
                    style={{
                      background: isActive ? "rgba(166, 59, 255, 0.18)" : '#190e2e',
                      border: `1.5px solid ${isActive ? '#a63bff' : "rgba(148, 163, 184, 0.2)"}`,
                      borderRadius: '8px',
                      padding: '10px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: isActive ? "0 0 12px rgba(166, 59, 255, 0.35)" : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '10px', fontWeight: 800, color: isActive ? '#c084fc' : '#94a3b8' }}>
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      {/* Action buttons on slide */}
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveSlide(idx, 'up');
                          }}
                          disabled={idx === 0}
                          title={t("Move slide up")}
                          style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '10px', cursor: 'pointer' }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveSlide(idx, 'down');
                          }}
                          disabled={idx === slides.length - 1}
                          title={t("Move slide down")}
                          style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '10px', cursor: 'pointer' }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDuplicateSlide(idx);
                          }}
                          title={t("Duplicate slide")}
                          style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '10px', cursor: 'pointer' }}
                        >
                          📋
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteSlide(idx);
                          }}
                          title={t("Delete slide")}
                          style={{ background: 'transparent', border: 'none', color: '#f87171', fontSize: '10px', cursor: 'pointer' }}
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    <button type="button" onClick={() => goToSlide(idx)} aria-current={isActive ? "true" : undefined} style={{ display: "block", width: "100%", textAlign: "left", color: "inherit", background: "transparent", border: 0, padding: 0 }}>
                    {s.kicker && (
                      <div style={{ fontSize: '9.5px', color: '#a78bfa', fontWeight: 600, textTransform: 'uppercase' }}>
                        {s.kicker}
                      </div>
                    )}
                    <strong style={{ fontSize: '11.5px', color: '#ffffff', display: 'block', lineHeight: 1.3 }}>
                      {s.title}
                    </strong>
                    {s.previewText && (
                      <p style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px', lineHeight: 1.3 }}>
                        {s.previewText}…
                      </p>
                    )}
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {/* ─── Presentation Stage (Active Slide) ─── */}
        <div
          className="html-deck-stage"
          style={{
            position: 'relative',
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            background: '#0d0818',
          }}
        >
          <iframe
            ref={iframeRef}
            title={displayTitle}
            srcDoc={sanitizeEditablePresentation(withPresentationTypography(frameHtml || currentHtml))}
            onLoad={handleIframeLoad}
            sandbox={EDITABLE_PRESENTATION_SANDBOX}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: livePreview && !restrictedScripts ? 'none' : 'block',
            }}
          />
          {!restrictedScripts && (
            <iframe
              title={`${displayTitle} — isolated live preview`}
              ref={liveIframeRef}
              srcDoc={livePresentationSource(withPresentationTypography(savedHtml || currentHtml))}
              sandbox={LIVE_PRESENTATION_SANDBOX}
              referrerPolicy="no-referrer"
              style={{ width: '100%', height: '100%', border: 'none', display: 'block', position: 'absolute', inset: 0, opacity: livePreview ? 1 : 0, pointerEvents: livePreview ? 'auto' : 'none' }}
              aria-hidden={!livePreview}
              tabIndex={livePreview ? 0 : -1}
            />
          )}
        </div>
      </div>

      {/* ─── Interactive Chart & Metric Data Editor Modal ─── */}
      {showDataModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100000,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <button type="button" className="agent-edit-backdrop" aria-label={t("Close")} onClick={() => setShowDataModal(false)} />
          <div
            role="dialog" aria-modal="true" aria-label={t("Edit chart data")}
            style={{
              position: 'relative',
              width: '100%',
              maxWidth: '680px',
              background: '#150a24',
              border: '1.5px solid #5b1f8a',
              borderRadius: '14px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 20px',
                background: '#1c1030',
                borderBottom: '1px solid #30224a',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>📊</span>
                <strong style={{ color: '#ffffff', fontSize: '15px' }}>{t("Edit Presentation Numbers & Charts")}</strong>
              </div>
              <button
                type="button"
                onClick={() => setShowDataModal(false)}
                style={{ background: 'transparent', border: 'none', color: '#ffffff', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '18px 20px', maxHeight: 'calc(60vh / var(--ui-scale, 1))', overflowY: 'auto' }}>
              {detectedCharts.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: '13px' }}>
                  {t("No active chart datasets detected on the current slide. Navigate to a chart slide (e.g., Governance Pillars or Compliance) and re-open.")}</p>
              ) : (
                detectedCharts.map((ch) => (
                  <div key={ch.id} style={{ marginBottom: '20px' }}>
                    <strong style={{ color: '#c084fc', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
                      {ch.name}
                    </strong>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', color: '#ffffff' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #30224a', color: '#94a3b8' }}>
                          <th style={{ textAlign: 'left', padding: '6px' }}>{t("Category / Label")}</th>
                          <th style={{ textAlign: 'right', padding: '6px' }}>{t("Value / Percentage")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ch.labels.map((lbl, lIdx) => (
                          <tr key={lIdx} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                            <td style={{ padding: '6px' }}>
                              <input
                                type="text"
                                defaultValue={lbl}
                                onChange={(e) => {
                                  ch.labels[lIdx] = e.target.value;
                                }}
                                style={{
                                  width: '100%',
                                  background: '#0d0818',
                                  border: '1px solid #30224a',
                                  borderRadius: '4px',
                                  padding: '4px 8px',
                                  color: '#ffffff',
                                  fontSize: '12px',
                                }}
                              />
                            </td>
                            <td style={{ padding: '6px', textAlign: 'right' }}>
                              <input
                                type="number"
                                defaultValue={ch.values[lIdx] || 0}
                                onChange={(e) => {
                                  ch.values[lIdx] = Number.parseFloat(e.target.value) || 0;
                                }}
                                style={{
                                  width: '90px',
                                  background: '#0d0818',
                                  border: '1px solid #30224a',
                                  borderRadius: '4px',
                                  padding: '4px 8px',
                                  color: '#4ade95',
                                  fontSize: '12px',
                                  textAlign: 'right',
                                  fontWeight: 650,
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: '10px', textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => applyChartData(ch.id, ch.labels, ch.values)}
                        style={{
                          background: 'linear-gradient(135deg, #a63bff 0%, #7b00e0 100%)',
                          border: 'none',
                          color: '#ffffff',
                          padding: '6px 14px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {t("Apply Changes")}</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 18px',
          fontSize: '11px',
          color: '#cbd5e1',
          background: '#150a24',
          borderTop: '1px solid #30224a',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>{t("Editable presentation · isolated live mode supports Chart.js and GSAP")}</span>
          {isDirty && (
            <span style={{ color: '#fbbf24', fontWeight: 700 }}>
              {t("• Unsaved changes (Click Save)")}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '14px' }}>
          <span>{t("Use ← → keys or sidebar to navigate")}</span>
          <span>{t("Click")}<strong>{t("✏️ Edit Text")}</strong> {t("to customize headings & numbers")}</span>
        </div>
      </div>
      {sessionId && filename && <SavedArtifactReview sessionId={sessionId} path={filename} disabled={isWorking || isDirty || isSaving} />}
    </div>
  );
};
