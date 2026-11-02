import { Toolbar } from './Toolbar';
import { t } from "../lib/i18n";
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { CopyButton } from './CopyButton';

interface CodeFile { url: string; name: string; code?: string; error?: string }

export function GeneratedCodePreview({ rootRef, contentKey, isStreaming, sessionId }: {
  rootRef: RefObject<HTMLDivElement | null>; contentKey: string; isStreaming?: boolean; sessionId?: string;
}) {
  const [result, setResult] = useState<{ key: string; files: CodeFile[] } | null>(null);
  const key = `${sessionId || 'legacy'}:${contentKey}`;
  useEffect(() => {
    if (isStreaming || !rootRef.current) return;
    const controller = new AbortController();
    async function load() {
      // Wait for MarkdownView to finish resolving file links in this commit.
      await Promise.resolve();
      if (controller.signal.aborted || !rootRef.current) return;
      const urls = new Map<string, CodeFile>();
      for (const anchor of rootRef.current.querySelectorAll('a[href]')) {
        const url = new URL(anchor.getAttribute('href')!, window.location.origin);
        if (url.origin !== window.location.origin || url.pathname !== `/sessions/${encodeURIComponent(sessionId || 'legacy')}/file`) continue;
        const path = url.searchParams.get('path');
        if (!path || !/\.py$/i.test(path)) continue;
        urls.set(url.pathname + url.search, { url: url.pathname + url.search, name: path });
      }
      void Promise.all([...urls.values()].map(async file => {
        try {
          const response = await fetch(file.url, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Could not load this file.');
          if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('This file is too large to preview. Download it to view the code.');
          const code = await response.text();
          if (code.length > 1024 * 1024) throw new Error('This file is too large to preview. Download it to view the code.');
          return { ...file, code };
        } catch (error) {
          return { ...file, error: error instanceof Error ? error.message : 'Could not load this file.' };
        }
      })).then(files => { if (!controller.signal.aborted) setResult({ key, files }); });
    }
    void load();
    return () => controller.abort();
  }, [rootRef, contentKey, isStreaming, sessionId, key]);
  if (isStreaming || result?.key !== key) return null;
  return <>{result.files.map(file => <section className="code-subwindow" key={file.url} aria-label={t("Python source: {0}", [file.name])}>
    <Toolbar className="code-subwindow-header">
      <strong>{file.name}</strong>
      <div className="code-subwindow-actions">
        {file.code !== undefined && <CopyButton className="code-subwindow-btn" text={file.code} label="Copy code" />}
        <a className="code-subwindow-btn" href={file.url} download={file.name.split('/').pop()}>{t("Download")}</a>
      </div>
    </Toolbar>
    <div className="code-subwindow-body">{file.error ? <p role="status">{file.error}</p> : <pre><code className="language-python">{file.code}</code></pre>}</div>
  </section>)}</>;
}
