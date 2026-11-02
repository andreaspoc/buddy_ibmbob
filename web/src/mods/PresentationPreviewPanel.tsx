import { Toolbar } from '../components/Toolbar';
import { ShareToPeopleButton } from '../components/ShareToPeople';
import { t } from "../lib/i18n";
import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { WorkspacePage, ChatMessage } from '../types';
import { WorkspaceDeckViewer } from '../components/WorkspaceDeckViewer';
// @ts-ignore
import { resolveDeckLayout, renderSlideToSvg } from '../lib/bobdeck.js';
import { HtmlDeckViewer, isCompleteHtmlDeck } from '../components/HtmlDeckViewer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { extractBobdeck, extractLiveBobdeck } from '../lib/extractDeck';
import { isPresentationFile, type LivePresentationArtifact } from '../lib/presentationFiles';
import { appConfirm } from '../components/AppDialog';
import { ArtifactChangeRequest } from '../components/ArtifactChangeRequest';
import { PresentationFile as Presentation, Renew, Maximize, Minimize, Close } from '@carbon/icons-react';
import './PresentationPreviewPanel.scss';

export interface PresentationPreviewPanelProps {
  isExpanded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  sessionId: string;
  isStreaming: boolean;
  pages: WorkspacePage[];
  files: Array<{ name: string; size: number }>;
  messages: ChatMessage[];
  activeMode: string;
  liveArtifact?: LivePresentationArtifact;
  presentationPath?: string;
  onClose: () => void;
  onRefreshPages?: () => void;
  onOpenFullscreen?: (page: WorkspacePage) => void;
}

function LiveDeckPreview({ deck }: { deck: any }) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [follow, setFollow] = useState(true);
  const canvas = useRef<HTMLDivElement>(null);
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  useEffect(() => {if (follow) setSlideIndex(Math.max(0, slides.length - 1));}, [slides.length, follow]);
  useEffect(() => {
    if (!canvas.current) return;
    canvas.current.replaceChildren();
    try {
      const resolved = resolveDeckLayout(deck);
      const slide = resolved.slides[Math.min(slideIndex, resolved.slides.length - 1)];
      if (!slide) return;
      const svg = renderSlideToSvg(slide, resolved.theme || {});
      svg.style.width = '100%';
      svg.style.height = 'auto';
      canvas.current.appendChild(svg);
    } catch { /* Incomplete layouts will render on the next snapshot. */ }
  }, [deck, slideIndex]);
  return <div className="mod-viewer-wrap">
    <div className="mod-panel-subtitle" role="status">{slides.length} {t("slides ready · Live preview")}</div>
    <div className="mod-panel-actions">
      <button type="button" disabled={slideIndex <= 0} onClick={() => {setFollow(false);setSlideIndex(index => index - 1);}} aria-label={t("Previous live slide")}>‹</button>
      <span>{t("Slide")} {Math.min(slideIndex + 1, slides.length)} {t("of")} {slides.length}</span>
      <button type="button" disabled={slideIndex >= slides.length - 1} onClick={() => {setFollow(false);setSlideIndex(index => index + 1);}} aria-label={t("Next live slide")}>›</button>
      <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />{t("Follow new slides")}</label>
    </div>
    <div ref={canvas} style={{ width: '100%', overflow: 'auto' }} />
  </div>;
}

/** The single presentation workspace, including live preview and persisted editing. */
export const PresentationPreviewPanel: React.FC<PresentationPreviewPanelProps> = ({
  sessionId, isStreaming, pages, files, messages, activeMode, liveArtifact,
  presentationPath, onClose, onRefreshPages, onOpenFullscreen, isExpanded = false, onDirtyChange,
}) => {
  const deckPages = useMemo(() => pages.filter(page => isPresentationFile(page) && /\.(html?|bobdeck)$/i.test(page.path)), [pages]);
  const [selectedFile, setSelectedFile] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [polledHtml, setPolledHtml] = useState('');
  const [savedSource, setSavedSource] = useState<{ content: string; sha256: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const [sourceError, setSourceError] = useState('');
  const previousContent = useRef('');
  const previousStreaming = useRef(isStreaming);
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const messageDeck = useMemo(() => isStreaming
    ? extractLiveBobdeck(lastAssistant?.content || '')
    : extractBobdeck(lastAssistant?.content || ''), [lastAssistant?.content, isStreaming]);
  const liveDeck = liveArtifact && isPresentationFile(liveArtifact) ? liveArtifact : undefined;

  useEffect(() => {
    setSelectedFile('');
    setPolledHtml('');
    previousContent.current = '';
  }, [sessionId]);

  useEffect(() => { if (liveDeck?.path && !dirty) setSelectedFile(liveDeck.path); }, [liveDeck?.path]);
  useEffect(() => { if (presentationPath && !dirty) setSelectedFile(presentationPath); }, [presentationPath]);

  useEffect(() => {
    if (selectedFile && (selectedFile === liveDeck?.path || selectedFile === presentationPath)) return;
    if (liveDeck?.path && !dirty) { setSelectedFile(liveDeck.path); return; }
    if (selectedFile && (deckPages.some(p => p.path === selectedFile || p.name === selectedFile) || files.some(f => f.name === selectedFile))) return;
    const candidate = deckPages[0]?.path || files.find(f => /\.bobdeck$/i.test(f.name))?.name;
    if (candidate) setSelectedFile(candidate);
  }, [liveDeck?.path, presentationPath, deckPages, files, selectedFile]);

  useEffect(() => {
    setPolledHtml('');
    previousContent.current = '';
    setSavedSource(null);
    setSourceError('');
  }, [selectedFile]);

  // Poll only the selected presentation, comparing content rather than length.
  useEffect(() => {
    if (!sessionId || !selectedFile || !isStreaming || liveDeck?.path === selectedFile) return;
    let cancelled = false;
    let busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`/workspace/page?path=${encodeURIComponent(selectedFile)}&session_id=${encodeURIComponent(sessionId)}`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && typeof data.html === 'string' && data.html !== previousContent.current) {
          previousContent.current = data.html;
          setPolledHtml(data.html);
        }
      } catch { /* The file may not yet exist while generation starts. */ }
      finally { busy = false; }
    };
    void update();
    const timer = setInterval(() => void update(), 1400);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, selectedFile, isStreaming, liveDeck?.path]);

  useEffect(() => {
    if (previousStreaming.current && !isStreaming) {
      setRefreshKey(key => key + 1);
      onRefreshPages?.();
    }
    previousStreaming.current = isStreaming;
  }, [isStreaming, onRefreshPages]);

  const activePage = deckPages.find(p => p.path === selectedFile || p.name === selectedFile);
  const isBobdeck = /\.bobdeck$/i.test(selectedFile);
  const isHtml = /\.html?$/i.test(selectedFile);
  const selectedLive = liveDeck?.path === selectedFile ? liveDeck : undefined;
  const html = selectedLive?.content || polledHtml;
  const streamedDeck = isBobdeck && selectedLive?.content ? extractLiveBobdeck(selectedLive.content) : messageDeck;
  const workingOnSelected = isStreaming && (selectedLive ? selectedLive.live !== false : (!liveDeck && (lastAssistant?.isPresentation || lastAssistant?.mode === 'presentation')));
  
  // Keep the last complete live snapshot when the worker finishes, so fetching
  // its new save version cannot briefly display the old presentation.
  useEffect(() => {
    if (workingOnSelected && isHtml && html && isCompleteHtmlDeck(html)) {
      setSavedSource(previous => previous ? { ...previous, content: html } : previous);
    }
  }, [workingOnSelected, isHtml, html]);

  const status = lastAssistant?.statusText || [...(lastAssistant?.workLog || [])].reverse().find(s => s.state === 'running' || s.state === 'started')?.text;
  useEffect(() => {
    if (!selectedFile || !isHtml || workingOnSelected) return;
    let active = true;
    // Keep the current editor visible while the newer version is fetched.
    const endpoint = `/sessions/${encodeURIComponent(sessionId)}/artifacts/source?path=${encodeURIComponent(selectedFile)}`;
    void fetch(endpoint).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Unable to load presentation');
      if (active) { setSavedSource(data); setSourceError(''); }
    }).catch(error => { if (active) setSourceError(error.message); });
    return () => { active = false; };
  }, [sessionId, selectedFile, isHtml, workingOnSelected, refreshKey]);

  const saveHtml = async (content: string) => {
    if (!savedSource?.sha256) throw new Error('Refresh the presentation before saving to load its current version.');
    const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/artifacts/source`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedFile, content, expected_sha256: savedSource.sha256 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Unable to save presentation');
    setSavedSource(data);
    onRefreshPages?.();
  };
  const fullscreenPage = activePage || (selectedFile ? { name: selectedFile.split('/').pop() || selectedFile, path: selectedFile, size: html?.length || 0, is_presentation: true } : undefined);

  return (
    <aside className="presentation-mod-panel presentation-studio" aria-label={t("Presentation Studio")}>
      <Toolbar as="header" className="mod-panel-header">
        <div className="mod-panel-title-group">
          <span className="studio-mark" aria-hidden="true"><Presentation size={24} /></span>
          <div className="mod-panel-headings">
            <h2 className="mod-panel-title">{t("Presentation Studio")}</h2>
            <div className="mod-panel-subtitle" title={selectedFile || undefined}>{workingOnSelected ? (status || t("Creating your presentation…")) : (selectedFile.split('/').pop() || t("Create or open a presentation"))}</div>
          </div>
        </div>
        <div className="mod-panel-actions studio-window-actions" aria-label={t("Studio window actions")}>
          <button type="button" className="mod-icon-btn" onClick={async () => {if (!dirty || await appConfirm('Discard unsaved presentation edits?')) onClose();}} title={t("Close Presentation Studio")} aria-label={t("Close Presentation Studio")}><Close size={20} /></button>
        </div>
      </Toolbar>
      <div className="studio-file-toolbar">
        <div className="studio-file-context">
          <span className="studio-file-label">{t("Presentation")}</span>
          <span className="studio-save-state" role="status">{t(workingOnSelected ? "Creating slides" : dirty ? "Unsaved changes" : selectedFile ? "Presentation selected" : "Ready when you are")}</span>
        </div>
        <div className="mod-panel-actions studio-file-actions">
          <ShareToPeopleButton item={{ kind: 'artifact', session_id: sessionId, path: selectedFile, title: selectedFile.split('/').pop() || 'Presentation' }} disabled={!selectedFile || dirty || workingOnSelected || isStreaming} title={dirty ? 'Save your changes before sharing' : 'Share a copy of this saved presentation'} />
          {deckPages.length > 1 && <select className="mod-deck-select" value={selectedFile} onChange={async event => { const next = event.target.value; if (!dirty || await appConfirm('Discard unsaved presentation edits?')) {setDirty(false);setSelectedFile(next);} }} aria-label={t("Select presentation")}>
            {deckPages.map(page => <option key={page.path} value={page.path}>{page.name}</option>)}
          </select>}
          <button type="button" className="mod-icon-btn" onClick={async () => { if (!dirty || await appConfirm('Discard unsaved presentation edits?')) {setDirty(false);setRefreshKey(key => key + 1);onRefreshPages?.();} }} title={t("Refresh presentation")} aria-label={t("Refresh presentation")}><Renew size={18} /></button>
          {onOpenFullscreen && <button type="button" className="mod-icon-btn" onClick={() => onOpenFullscreen(fullscreenPage || {name:'Presentation Studio',path:'',size:0,is_presentation:true})} title={isExpanded ? t("Return beside chat") : t("Expand Presentation Studio")} aria-label={isExpanded ? t("Return beside chat") : t("Expand Presentation Studio")}>{isExpanded ? <Minimize size={18} /> : <Maximize size={18} />}</button>}
        </div>
      </div>
      <div className="mod-panel-body">
        {selectedFile && isHtml && (savedSource || html) ? <div className="mod-viewer-wrap" key={`html-${sessionId}-${selectedFile}`}>
          <ErrorBoundary name="Presentation Studio"><HtmlDeckViewer filename={selectedFile} sessionId={sessionId} title={activePage?.name || selectedFile.split('/').pop()} htmlContent={workingOnSelected && html ? html : savedSource?.content || html} onSaveHtml={saveHtml} onDirtyChange={setDirty} isWorking={workingOnSelected} /></ErrorBoundary>
        </div> : workingOnSelected && streamedDeck?.deck ? <ErrorBoundary name="Live presentation"><LiveDeckPreview deck={streamedDeck.deck} /></ErrorBoundary> : !workingOnSelected && selectedFile && isBobdeck ? <div className="mod-viewer-wrap" key={`deck-${sessionId}-${selectedFile}`}>
          <ArtifactChangeRequest sessionId={sessionId} path={selectedFile} disabled={dirty || workingOnSelected} />
          <ErrorBoundary name="Presentation Studio"><WorkspaceDeckViewer filename={selectedFile} sessionId={sessionId} onSaved={onRefreshPages} onDirtyChange={setDirty} /></ErrorBoundary>
        </div> : <div className={workingOnSelected ? 'mod-generating-state' : 'mod-empty-state'} role="status">
          <div className="mod-generating-card">
            <span className="studio-empty-icon" aria-hidden="true"><Presentation size={40} /></span>
            <h3>{workingOnSelected ? t("Creating your presentation…") : t("Turn an idea into a presentation")}</h3>
            <p>{sourceError || (workingOnSelected ? (status || t("The preview appears here as Buddy writes your slides.")) : t("Select the Presentation Buddy skill in chat and describe your audience, topic, and goal. Preview your slides here, refine them, then export or share."))}</p>
            {!workingOnSelected && !sourceError && <ol className="studio-empty-steps"><li>{t("Describe your presentation in chat")}</li><li>{t("Review and edit your slides")}</li><li>{t("Export or share the finished deck")}</li></ol>}
            {activeMode === 'presentation' && workingOnSelected && <div className="mod-progress-track"><div className="mod-progress-bar" /></div>}
          </div>
        </div>}
      </div>
    </aside>
  );
};
