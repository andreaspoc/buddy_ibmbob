import { t } from "../lib/i18n";
import { useEffect, useState } from 'react';
import { SlideViewer } from './SlideViewer';

export function WorkspaceDeckViewer({ filename, sessionId = 'legacy', onSaved, onDirtyChange, isWorking = false }: { filename: string; isWorking?: boolean; sessionId?: string; onSaved?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [deck, setDeck] = useState<any>(null);
  const [sha256, setSha256] = useState('');
  const [error, setError] = useState('');
  const sourceUrl = `/sessions/${encodeURIComponent(sessionId)}/artifacts/source`;
  useEffect(() => {
    let disposed = false;
    setDeck(null); setSha256(''); setError('');
    void fetch(`${sourceUrl}?path=${encodeURIComponent(filename)}`).then(async response => {
        const source = await response.json();
        if (!response.ok) throw new Error(source.detail || 'Could not load this presentation.');
        return source;
      }).then(source => {
      if (disposed) return;
      const data = JSON.parse(source.content);
      if (Array.isArray(data?.slides)) { setDeck(data); setSha256(source.sha256); }
      else setError('Could not load this presentation.');
    }).catch(error => { if (!disposed) setError(error.message || 'Could not load this presentation.'); });
    return () => { disposed = true; };
  }, [filename, sessionId, sourceUrl]);
  async function saveJson(content: string) {
    if (!sha256) throw new Error('Reload the presentation before saving.');
    const response = await fetch(sourceUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filename, content, expected_sha256: sha256 }) });
    const saved = await response.json();
    if (!response.ok) throw new Error(saved.detail || 'Could not save this presentation.');
    setSha256(saved.sha256);
  }
  if (error) return <p role="alert">{t(error)}</p>;
  if (!deck) return <p role="status">{t("Loading presentation…")}</p>;
  return <SlideViewer isWorking={isWorking} deckData={deck} sessionId={sessionId} filename={filename} onSaved={onSaved} onSaveJson={saveJson} onDirtyChange={onDirtyChange} />;
}
