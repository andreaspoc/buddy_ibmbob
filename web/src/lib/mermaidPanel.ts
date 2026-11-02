import mermaid from 'mermaid';
import { createToolbarElement } from '../components/Toolbar';
import DOMPurify from 'dompurify';
import { saveSessionFile } from '../api';

let diagramCounter = 0;

export function normalizeMermaidSource(source: string): string {
  let cleaned = source;

  // 1. Normalize line breaks inside labels: replace literal \n inside quotes with <br/>
  cleaned = cleaned.replace(/\[[^\[\]]*\]|"(?:[^"\\]|\\.)*"/g, label => label.replace(/\\n/g, '<br/>'));

  // 2. Wrap unquoted node labels containing special characters that conflict with Mermaid shape syntax
  cleaned = cleaned.replace(/\b([a-zA-Z0-9_-]+)\[([^"\]]+)\]/g, (match, id, text) => {
    if (/[()\/&:]/.test(text) && !text.startsWith('(') && !text.endsWith(')')) {
      return `${id}["${text.trim()}"]`;
    }
    return match;
  });

  // 3. Fix unquoted edge labels containing slashes, colons, or plus
  cleaned = cleaned.replace(/-->\|([^"\|\n]+)\|/g, (match, label) => {
    if (/[\/:&+]/.test(label)) {
      return `-->|"${label.trim()}"|`;
    }
    return match;
  });

  // 4. Fix subgraphs with spaces in ID but no brackets (e.g. subgraph Layer One -> subgraph layer_one ["Layer One"])
  cleaned = cleaned.replace(/^[ \t]*subgraph[ \t]+([a-zA-Z0-9_-]+[ \t]+[^\n\[\s][^\n\[]*)$/gm, (match, title) => {
    const trimmed = title.trim();
    if (trimmed.includes(' ') && !trimmed.includes('[')) {
      const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      return `    subgraph ${slug} ["${trimmed}"]`;
    }
    return match;
  });

  return cleaned;
}

/** Build a contained diagram preview and a source editor without changing chat text. */
export function createMermaidPanel(pre: HTMLElement, original: string, sessionId?: string): { panel: HTMLElement; dispose: () => void } {
  let disposed = false;
  let applied = original;
  let rendering = false;
  let hash = 2166136261;
  for (let i = 0; i < original.length; i++) hash = Math.imul(hash ^ original.charCodeAt(i), 16777619);
  const filename = `diagram-${(hash >>> 0).toString(16)}.mmd`;
  const panel = document.createElement('div');
  panel.className = 'mermaid-panel';
  panel.dataset.mermaidSource = original;
  panel.dataset.mermaidSession = sessionId || '';
  const header = createToolbarElement('mermaid-header');
  const caption = document.createElement('span');
  caption.className = 'mermaid-caption';
  caption.textContent = 'Diagram';
  const actions = document.createElement('div');
  actions.className = 'mermaid-actions';
  const button = (label: string) => {
    const element = document.createElement('button');
    element.type = 'button'; element.className = 'mermaid-fit'; element.textContent = label;
    return element;
  };
  const fit = button('Actual size');
  const maximize = button('Maximize');
  const edit = button('Edit code');
  actions.append(fit, maximize, edit);
  header.append(caption, actions);
  const diagram = document.createElement('div');
  diagram.className = 'mermaid-diagram fitted';
  const editor = document.createElement('div');
  editor.className = 'mermaid-editor'; editor.hidden = true;
  const input = document.createElement('textarea');
  input.value = original; input.rows = 12; input.spellcheck = false;
  input.setAttribute('aria-label', 'Mermaid code');
  const controls = document.createElement('div');
  controls.className = 'mermaid-actions';
  const apply = button('Apply');
  const save = button('Save');
  const cancel = button('Close editor');
  save.hidden = !sessionId;
  controls.append(apply, save, cancel);
  const status = document.createElement('p');
  status.className = 'mermaid-editor-status'; status.setAttribute('role', 'status');
  editor.append(input, controls);
  const details = document.createElement('details');
  details.className = 'mermaid-source';
  const summary = document.createElement('summary'); summary.textContent = 'View Mermaid source';
  const sourcePre = document.createElement('pre');
  const sourceCode = document.createElement('code'); sourceCode.textContent = original;
  sourcePre.append(sourceCode); details.append(summary, sourcePre);
  panel.append(header, diagram, editor, status, details);
  pre.replaceWith(panel);

  const render = async (source: string): Promise<boolean> => {
    if (rendering) return false;
    rendering = true; apply.disabled = save.disabled = true;
    status.textContent = '';
    const diagramId = `bob-diagram-${++diagramCounter}`;
    try {
      const normalized = normalizeMermaidSource(source);
      const result = await mermaid.render(diagramId, normalized);
      if (disposed) return false;
      const safeSvg = DOMPurify.sanitize(result.svg, { ADD_TAGS: ['foreignObject'] });
      diagram.innerHTML = safeSvg;
      const svg = diagram.querySelector('svg');
      const width = Math.ceil(svg?.viewBox?.baseVal?.width || 0);
      if (svg && width) { diagram.style.setProperty('--mermaid-natural-width', `${width}px`); svg.style.width = `${width}px`; svg.style.maxWidth = 'none'; svg.style.height = 'auto'; }
      applied = source; sourceCode.textContent = source;
      caption.textContent = 'Diagram';
      return true;
    } catch (err: unknown) {
      if (!disposed) {
        const errorMsg = (err instanceof Error ? err.message : String(err)) || 'Syntax error';
        status.textContent = `Could not render diagram: ${errorMsg}. Check syntax in the editor below.`;
        status.setAttribute('role', 'alert');
        editor.hidden = false;
        // Clean up any stray error container Mermaid creates in the DOM
        const stray = document.getElementById(diagramId) || document.getElementById(`d${diagramId}`);
        stray?.remove();
      }
      return false;
    } finally { rendering = false; apply.disabled = save.disabled = false; }
  };
  fit.addEventListener('click', () => {
    const fitted = diagram.classList.toggle('fitted');
    fit.textContent = fitted ? 'Actual size' : 'Fit to width';
    diagram.scrollLeft = 0;
  });
  const fullscreenChanged = () => {
    if (document.fullscreenElement === panel) panel.classList.add('maximized');
    else if (panel.dataset.nativeFullscreen) { panel.classList.remove('maximized'); delete panel.dataset.nativeFullscreen; }
    maximize.textContent = panel.classList.contains('maximized') ? 'Return' : 'Maximize';
    maximize.setAttribute('aria-expanded', String(panel.classList.contains('maximized')));
  };
  const restore = async () => {
    if (document.fullscreenElement === panel) await document.exitFullscreen().catch(() => {});
    panel.classList.remove('maximized'); delete panel.dataset.nativeFullscreen;
    fullscreenChanged(); maximize.focus();
  };
  maximize.addEventListener('click', async () => {
    if (panel.classList.contains('maximized')) { await restore(); return; }
    panel.classList.add('maximized');
    diagram.classList.add('fitted'); fit.textContent = 'Actual size';
    fullscreenChanged();
    try { await panel.requestFullscreen(); panel.dataset.nativeFullscreen = 'true'; }
    catch { /* The fixed overlay also works when native fullscreen is unavailable. */ }
  });
  const onEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && panel.classList.contains('maximized') && !document.fullscreenElement) {
      event.preventDefault(); void restore();
    }
  };
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('keydown', onEscape);
  edit.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    if (!editor.hidden) input.focus();
    edit.setAttribute('aria-expanded', String(!editor.hidden));
  });
  cancel.addEventListener('click', () => { input.value = applied; editor.hidden = true; edit.setAttribute('aria-expanded', 'false'); edit.focus(); });
  apply.addEventListener('click', async () => {
    if (await render(input.value)) { status.setAttribute('role', 'status'); status.textContent = sessionId ? 'Preview updated. Save to keep these changes.' : 'Preview updated.'; }
  });
  save.addEventListener('click', async () => {
    if (!sessionId || !await render(input.value)) return;
    save.disabled = apply.disabled = true;
    const snapshot = applied;
    try {
      await saveSessionFile(sessionId, filename, snapshot);
      if (!disposed) { status.setAttribute('role', 'status'); status.textContent = 'Diagram saved.'; }
    } catch {
      if (!disposed) { status.setAttribute('role', 'alert'); status.textContent = 'Could not save the diagram. Your edited code and preview are still available.'; }
    } finally { save.disabled = apply.disabled = false; }
  });
  edit.disabled = true;
  void (async () => {
    let source = original;
    if (sessionId) {
      try {
        const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filename)}`);
        if (response.ok) source = await response.text();
      } catch { /* Use the original source if no saved revision is available. */ }
    }
    if (disposed) return;
    input.value = source;
    await render(source);
    edit.disabled = false;
  })();
  return { panel, dispose: () => {
    disposed = true;
    document.removeEventListener('fullscreenchange', fullscreenChanged);
    document.removeEventListener('keydown', onEscape);
    if (document.fullscreenElement === panel) void document.exitFullscreen().catch(() => {});
  } };
}
