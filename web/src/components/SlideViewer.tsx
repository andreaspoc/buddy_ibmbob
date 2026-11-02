import { Toolbar } from './Toolbar';
import { SavedArtifactReview } from './ArtifactReviewComments';
import { t } from "../lib/i18n";
import { appAlert, appConfirm } from './AppDialog';
import { saveSessionFile, fetchDeckByPath } from '../api';
import { DeckEditPanel } from './DeckEditPanel';
import { navigateOffice } from '../lib/officeUrl';
import React, { useState, useRef, useEffect } from 'react';
// @ts-ignore
import { renderSlideToSvg, exportDeckToPptx, buildDeckPptxBlob, resolveDeckLayout } from '../lib/bobdeck.js';

interface SlideViewerProps {
  isWorking?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveJson?: (content: string) => Promise<void>;
  deckData: any;
  rawJson?: string;
  sessionId?: string;
  filename?: string;
  onSaved?: () => void;
}

export const SlideViewer: React.FC<SlideViewerProps> = (props) => {
  const { deckData } = props;
  if (!deckData || typeof deckData !== 'object') {
    return (
      <div className="bobdeck-viewer" style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ color: '#888', margin: 0 }}>{t("Presentation deck is loading or unavailable.")}</p>
      </div>
    );
  }

  return <LoadedSlideViewer {...props} />;
};

// Loading and available decks have separate lifecycles so availability changes
// never change the hook order of an existing component instance.
const LoadedSlideViewer: React.FC<SlideViewerProps> = ({ deckData, rawJson, sessionId, filename, onSaved, onDirtyChange, onSaveJson, isWorking = false }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  let safeSource = '{}';
  try {
    safeSource = JSON.stringify(deckData);
  } catch {}
  const sourceJson = safeSource;
  const [editedDeck, setEditedDeck] = useState<any>(() => {
    try {
      return JSON.parse(sourceJson);
    } catch {
      return deckData || {};
    }
  });
  const [savedJson, setSavedJson] = useState(sourceJson);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedElement, setSelectedElement] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(Boolean(sessionId));
  const [saveError, setSaveError] = useState('');
  let currentJson = '';
  try {
    currentJson = JSON.stringify(editedDeck);
  } catch {
    currentJson = sourceJson;
  }
  const isDirty = currentJson !== savedJson;
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  // Inline decks get a stable artifact name, independent of transient chat IDs.
  let hash = 2166136261;
  for (let i = 0; i < sourceJson.length; i++) hash = Math.imul(hash ^ sourceJson.charCodeAt(i), 16777619);
  const artifactPath = filename || `presentation-${(hash >>> 0).toString(16)}.bobdeck`;
  useEffect(() => {
    let disposed = false;
    try {
      const parsed = JSON.parse(sourceJson);
      setEditedDeck(parsed);
      setSavedJson(sourceJson);
    } catch {}
    setCurrentIndex(0);
    setSelectedElement(0);
    setSaveError('');
    setOfficeSuiteSavedFile(null);
    setIsLoadingSaved(Boolean(sessionId && !onSaveJson));
    if (sessionId && !onSaveJson) fetchDeckByPath(artifactPath, sessionId).then(deck => {
      if (!disposed && Array.isArray(deck?.slides)) {
        setEditedDeck(deck);
        setSavedJson(JSON.stringify(deck));
      }
    }).catch(() => {}).finally(() => { if (!disposed) setIsLoadingSaved(false); });
    return () => { disposed = true; };
  }, [sourceJson, sessionId, artifactPath]);
  useEffect(() => {
    const onDeckSaved = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!isDirty && detail?.sessionId === sessionId && detail?.path === artifactPath) {
        setEditedDeck(detail.deck);
        setSavedJson(JSON.stringify(detail.deck));
      }
    };
    window.addEventListener('buddy-deck-saved', onDeckSaved);
    return () => window.removeEventListener('buddy-deck-saved', onDeckSaved);
  }, [sessionId, artifactPath, isDirty]);
  const updateElement = (patch: any) => {
    setEditedDeck((previous: any) => {
      const next = structuredClone(previous);
      const elements = next.slides[currentIndex]?.elements || [];
      const element = elements[Math.min(selectedElement, elements.length - 1)];
      if (element) Object.assign(element, patch);
      return next;
    });
    setSaveError('');
  };
  const saveEdits = async () => {
    if (!sessionId) return;
    setIsSaving(true);
    setSaveError('');
    try {
      if (onSaveJson) await onSaveJson(currentJson);
      else await saveSessionFile(sessionId, artifactPath, currentJson);
      setSavedJson(currentJson);
      window.dispatchEvent(new CustomEvent('buddy-deck-saved', {
        detail: { sessionId, path: artifactPath, deck: JSON.parse(currentJson) },
      }));
      onSaved?.();
    } catch (error: any) {
      setSaveError(error.message || 'Could not save presentation');
    } finally { setIsSaving(false); }
  };
  const revertEdits = async () => {
    if (await appConfirm('Discard unsaved presentation changes?')) {
      try {
        setEditedDeck(JSON.parse(savedJson));
      } catch {}
      setSaveError('');
    }
  };
  const [isExporting, setIsExporting] = useState(false);
  const [isUploadingOfficeSuite, setIsUploadingOfficeSuite] = useState(false);
  const [officeSuiteSavedFile, setOfficeSuiteSavedFile] = useState<{ id: string; name: string } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  let resolved: any = { slides: [], theme: {} };
  try {
    resolved = resolveDeckLayout(editedDeck) || { slides: [], theme: {} };
  } catch (layoutErr) {
    console.error('Failed to resolve deck layout:', layoutErr);
  }
  const slides = Array.isArray(resolved?.slides) ? resolved.slides : [];
  const theme = resolved?.theme || {};
  const totalSlides = slides.length;

  useEffect(() => {
    if (!canvasRef.current) return;
    if (totalSlides === 0 || !slides[currentIndex]) {
      canvasRef.current.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">No slides available</div>';
      return;
    }
    try {
      canvasRef.current.innerHTML = '';
      const svg = renderSlideToSvg(slides[currentIndex], theme, 1);
      canvasRef.current.appendChild(svg);
      if (isEditing) {
        svg.querySelectorAll('[data-element-index]').forEach((element: Element) => {
          const index = Number(element.getAttribute('data-element-index'));
          (element as SVGElement).style.cursor = 'pointer';
          element.addEventListener('click', () => setSelectedElement(index));
        });
      }
    } catch (renderErr) {
      console.error('Failed to render slide SVG:', renderErr);
      if (canvasRef.current) {
        canvasRef.current.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444;">Could not render slide ${currentIndex + 1}</div>`;
      }
    }
  }, [currentIndex, currentJson, isEditing, slides, theme, totalSlides]);

  useEffect(() => { setSelectedElement(0); }, [currentIndex]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = !!document.fullscreenElement && document.fullscreenElement === containerRef.current;
      setIsFullscreen(isNowFullscreen);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFullscreen || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        setCurrentIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        setCurrentIndex((prev) => Math.min(totalSlides - 1, prev + 1));
      } else if (e.key === 'Escape') {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, totalSlides]);

  const handlePptxDownload = async () => {
    try {
      setIsExporting(true);
      const cleanName = (editedDeck?.title || deckData?.title || 'presentation')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_');
      await exportDeckToPptx(editedDeck, `${cleanName}.pptx`);
    } catch (err: any) {
      void appAlert('PPTX Export failed: ' + (err.message || String(err)));
    } finally {
      setIsExporting(false);
    }
  };

  const handleSaveToOfficeSuite = async (openInEditor = false) => {
    try {
      setIsUploadingOfficeSuite(true);
      setSaveError('');
      const rawTitle = String(editedDeck?.title || deckData?.title || 'Presentation').trim();
      const safeBase = rawTitle.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Presentation';
      const fileName = safeBase.toLowerCase().endsWith('.pptx') ? safeBase : `${safeBase}.pptx`;
      const blob = await buildDeckPptxBlob(editedDeck);
      const file = new File([blob], fileName, {
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
      setSaveError(err.message || String(err));
    } finally {
      setIsUploadingOfficeSuite(false);
    }
  };

  const handleJsonDownload = () => {
    const blob = new Blob([JSON.stringify(editedDeck || {}, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(editedDeck?.title || deckData?.title || 'presentation').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.bobdeck`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement && !isFullscreen) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {
          setIsFullscreen(true);
        });
      } else {
        setIsFullscreen(true);
      }
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {
          setIsFullscreen(false);
        });
      } else {
        setIsFullscreen(false);
      }
    }
  };

  if (totalSlides === 0) {
    return (
      <div className="bobdeck-viewer" style={{ padding: '28px', textAlign: 'center' }}>
        <p style={{ color: '#6b7280', margin: 0 }}>{t("Presentation deck has no slides yet.")}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`bobdeck-viewer ${isFullscreen ? 'fullscreen' : ''}`}
    >
      <Toolbar className="bobdeck-header">
        <div className="bobdeck-title-wrap">
          <span className="bobdeck-brand-pill">
            {deckData?.metadata?.brand || t("BobDeck")}
          </span>
          <strong className="bobdeck-title">
            {editedDeck?.title || deckData?.title || t("Executive Presentation")}
          </strong>
        </div>

        <div className="bobdeck-actions">
          <button type="button" className="bobdeck-btn" disabled={isLoadingSaved} onClick={() => setIsEditing(!isEditing)}>{isEditing ? t("Done Editing") : t("✏️ Edit")}</button>
          {isDirty && <>
            <button type="button" className="bobdeck-btn" onClick={saveEdits} disabled={isSaving || !sessionId}>{isSaving ? t("Saving…") : t("Save")}</button>
            <button type="button" className="bobdeck-btn" onClick={revertEdits} disabled={isSaving}>{t("Revert")}</button>
          </>}
          <button
            type="button"
            className="bobdeck-btn bobdeck-btn-primary office-desktop-action"
            onClick={() => void handleSaveToOfficeSuite(false)}
            disabled={isUploadingOfficeSuite || isWorking}
            title={t("Save this PowerPoint (.pptx) to your personal Office Suite storage")}
          >
            <span aria-hidden="true">☁</span>{" "}
            {isUploadingOfficeSuite ? t("Saving to Office Suite…") : officeSuiteSavedFile ? t("✓ Saved in Office Suite") : t("Save to Office Suite")}
          </button>
          <button
            type="button"
            className="bobdeck-btn office-desktop-action"
            onClick={() => {
              if (officeSuiteSavedFile && !isDirty) {
                navigateOffice(`/office/files/${officeSuiteSavedFile.id}`);
              } else {
                void handleSaveToOfficeSuite(true);
              }
            }}
            disabled={isUploadingOfficeSuite || isWorking}
            title={t("Save to Office Suite and open in ONLYOFFICE PowerPoint editor")}
          >
            <span aria-hidden="true">▦</span>{" "}
            {t("Open in Office Suite")}
          </button>
          <button
            type="button"
            className="bobdeck-btn"
            onClick={handlePptxDownload}
            disabled={isExporting}
 title={t("Download PowerPoint presentation (.pptx)")} ><span aria-hidden="true">📊</span>{" "}
            {isExporting ? t("Generating PPTX…") : t("Download PPTX")}
          </button>
          <button
            type="button"
            className="bobdeck-btn"
            onClick={handleJsonDownload}
 title={t("Download raw .bobdeck JSON file")} ><span aria-hidden="true">💾</span> .bobdeck</button>
          <button
            type="button"
            className="bobdeck-btn bobdeck-btn-icon"
            onClick={toggleFullscreen}
            title={isFullscreen ? t("Exit Fullscreen (Esc)") : t("Maximize Presentation")}
          >
            {isFullscreen ? '✕' : '⛶'}
          </button>
        </div>
      </Toolbar>

      {saveError && <p className="bobdeck-edit-error" role="alert">{saveError}</p>}
      {officeSuiteSavedFile && !saveError && (
        <p className="bobdeck-edit-notice office-desktop-action" role="status">
          {t("Saved \"{0}\" to your personal Office Suite storage.", [officeSuiteSavedFile.name])}{" "}
          <button
            type="button"
            className="bobdeck-btn"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: '11px' }}
            onClick={() => navigateOffice(`/office/files/${officeSuiteSavedFile.id}`)}
          >
            {t("Open in Office Suite →")}
          </button>
        </p>
      )}
      {isDirty && <p className="bobdeck-edit-notice">{t("Unsaved changes. Downloads include your edits.")}{!sessionId && t(" Save is available in a conversation.")}</p>}
      {isEditing && <DeckEditPanel
        slide={editedDeck.slides?.[currentIndex]} selectedIndex={selectedElement}
        onSelect={setSelectedElement} onChange={updateElement}
      />}
      <div className="bobdeck-canvas-area">
        {isFullscreen && currentIndex > 0 && (
          <button
            type="button"
            className="bobdeck-stage-arrow bobdeck-stage-arrow-left"
            onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
            title={t("Previous Slide (←)")}
            aria-label={t("Previous Slide")}
          >
            ‹
          </button>
        )}
        <div ref={canvasRef} className="bobdeck-canvas-inner" />
        {isFullscreen && currentIndex < totalSlides - 1 && (
          <button
            type="button"
            className="bobdeck-stage-arrow bobdeck-stage-arrow-right"
            onClick={() => setCurrentIndex((prev) => Math.min(totalSlides - 1, prev + 1))}
            title={t("Next Slide (→ or Space)")}
            aria-label={t("Next Slide")}
          >
            ›
          </button>
        )}
      </div>

      <div className="bobdeck-footer">
        <div className="bobdeck-nav">
          <button
            type="button"
            className="bobdeck-btn bobdeck-btn-icon"
            onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
            disabled={currentIndex === 0}
            title={t("Previous Slide")}
          >
            ◀
          </button>
          <span className="bobdeck-counter">
            {t("Slide")}{currentIndex + 1} {t("of")}{totalSlides}
          </span>
          <button
            type="button"
            className="bobdeck-btn bobdeck-btn-icon"
            onClick={() =>
              setCurrentIndex((prev) => Math.min(totalSlides - 1, prev + 1))
            }
            disabled={currentIndex >= totalSlides - 1}
            title={t("Next Slide")}
          >
            ▶
          </button>
          {isFullscreen && (
            <span
              style={{
                fontSize: '11px',
                color: '#94a3b8',
                marginLeft: '8px',
                opacity: 0.8,
              }}
            >
              {t("(Navigate with ← / → or Space)")}</span>
          )}
        </div>

        <div className="bobdeck-dots">
          {slides.map((_: any, idx: number) => (
            <button
              key={idx}
              type="button"
              className={`bobdeck-dot ${idx === currentIndex ? 'active' : ''}`}
              onClick={() => setCurrentIndex(idx)}
              title={t("Jump to slide {0}", [idx + 1])}
            />
          ))}
        </div>
      </div>

      {rawJson && (
        <details className="bobdeck-source-details">
          <summary>
            <span>{t("View generated .bobdeck JSON source")}</span>
            <span className="bobdeck-source-hint">{t("Collapsed submenu")}</span>
          </summary>
          <div className="bobdeck-source-content">
            <pre>
              <code>{JSON.stringify(editedDeck, null, 2)}</code>
            </pre>
          </div>
        </details>
      )}
      {sessionId && filename && <SavedArtifactReview sessionId={sessionId} path={artifactPath} disabled={isWorking || isDirty || isSaving || isLoadingSaved} />}
    </div>
  );
};
