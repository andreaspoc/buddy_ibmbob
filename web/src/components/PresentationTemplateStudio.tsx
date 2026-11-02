import { Toolbar } from './Toolbar';
import { t, useLanguage } from '../lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresentationTemplate } from '../types';
// @ts-ignore JavaScript renderer shared with the presentation viewer.
import { exportDeckToPptx, renderSlideToSvg } from '../lib/bobdeck.js';
import { createTemplateHtml, createTemplatePreviewDeck, defaultTemplateDesign, templateDesignError } from '../lib/templateDesign';
import type { TemplateDesign } from '../lib/templateDesign';
import './PresentationTemplateStudio.css';

export function PresentationTemplateStudio({ templates, onSaved, onCancel, sessionId, onAskBob, bobBusy }: { sessionId?: string; onAskBob?: (brief: string) => void; bobBusy?: boolean; templates: PresentationTemplate[]; onSaved: (template: PresentationTemplate) => void; onCancel: () => void }) {
  const language = useLanguage();
  const editedText = useRef({ title: false, brand: false });
  const defaultLabels = useRef({ title: t(defaultTemplateDesign.title), brand: t(defaultTemplateDesign.brand) });
  const [value, setValue] = useState<TemplateDesign>(() => ({ ...structuredClone(defaultTemplateDesign), ...defaultLabels.current }));
  useEffect(() => {
    const previous = defaultLabels.current;
    const next = { title: t(defaultTemplateDesign.title), brand: t(defaultTemplateDesign.brand) };
    setValue(current => ({ ...current, title: !editedText.current.title && current.title === previous.title ? next.title : current.title, brand: !editedText.current.brand && current.brand === previous.brand ? next.brand : current.brand }));
    defaultLabels.current = next;
  }, [language]);
  const [page, setPage] = useState(0);
  const [brief, setBrief] = useState('');
  const [drafts, setDrafts] = useState<Array<{ path: string; config: TemplateDesign }>>([]);
  const [draftPath, setDraftPath] = useState('');
  async function refreshDrafts() {
    if (!sessionId) return;
    setBusy('Loading Bob drafts…'); setError('');
    try {
      const response = await fetch(`/presentation/template-drafts?session_id=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not load Bob drafts. Please try again.');
      const data = await response.json();
      setDrafts(Array.isArray(data) ? data : data.drafts || []);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load Bob drafts.'); }
    finally { setBusy(''); }
  }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [starter, setStarter] = useState('');
  const preview = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const deck = useMemo(() => createTemplatePreviewDeck(value, t), [value, language]);
  const invalid = templateDesignError(value);
  const previewNames = deck.slides.map(slide => t(slide.id === 'hero' ? 'Title slide' : slide.id === 'content' ? 'Content slide' : slide.id === 'chart' ? 'Chart slide' : 'Closing slide'));
  useEffect(() => { setPage(current => Math.min(current, deck.slides.length - 1)); }, [deck.slides.length]);
  useEffect(() => {
    if (preview.current) preview.current.replaceChildren(renderSlideToSvg(deck.slides[Math.min(page, deck.slides.length - 1)], deck.theme));
  }, [deck, page]);
  const update = <K extends keyof TemplateDesign>(key: K, next: TemplateDesign[K]) => {
    if (key === 'title') editedText.current.title = true;
    if (key === 'brand') editedText.current.brand = true;
    setValue(current => ({ ...current, [key]: next }));
  };
  async function copyStarter(id: string) {
    setStarter(id);
    if (!id) return;
    setBusy('Loading starter…'); setError('');
    try {
      const response = await fetch(`/presentation/templates/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not load this starter. Please try again.');
      const data = await response.json();
      const theme = data.theme || data;
      const studio = data.metadata?.studioConfig || data.studio || data.studioConfig || data.studio_config || theme;
      const catalog = templates.find(item => item.id === id);
      const colors = studio.colors || theme.colors || catalog?.colors || {};
      const normalized = { ...defaultTemplateDesign.colors };
      for (const key of Object.keys(normalized) as Array<keyof typeof normalized>) {
        const raw = colors[key];
        if (typeof raw === 'string') {
          const hex = raw.replace(/^#/, '');
          if (/^[0-9a-f]{6}$/i.test(hex)) normalized[key] = `#${hex}`;
        }
      }
      editedText.current = { title: true, brand: true };
      setValue({ title: t('{0} copy', [catalog?.title || data.title || t('Starter')]).slice(0, 100), brand: studio.brand || catalog?.brand || '', colors: normalized, fonts: { ...defaultTemplateDesign.fonts, ...(studio.fonts || theme.fonts || catalog?.fonts || {}) }, design: { ...defaultTemplateDesign.design, ...(studio.design || {}) } });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load starter.'); }
    finally { setBusy(''); }
  }
  async function save() {
    if (inFlight.current) return;
    if (invalid) { setError(invalid); return; }
    inFlight.current = true; setBusy('Saving…'); setError('');
    try {
      const response = await fetch('/presentation/templates', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, title: value.title.trim(), brand: value.brand.trim() }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save your template. Please try again.');
      onSaved(data.template || data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save template.'); }
    finally { inFlight.current = false; setBusy(''); }
  }
  async function download(format: 'html' | 'pptx') {
    if (inFlight.current) return;
    if (invalid) { setError(invalid); return; }
    inFlight.current = true; setBusy('Preparing download…'); setError('');
    const filename = value.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'template';
    try {
      if (format === 'pptx') await exportDeckToPptx(deck, `${filename}.pptx`);
      else {
        const content = createTemplateHtml(value, deck.slides.map(slide => new XMLSerializer().serializeToString(renderSlideToSvg(slide, deck.theme))), { language, translate: t });
        const url = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `${filename}.html`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create download.'); }
    finally { inFlight.current = false; setBusy(''); }
  }
  const colorKeys = Object.keys(value.colors) as Array<keyof TemplateDesign['colors']>;
  return <section className="template-studio" aria-label={t("Template Studio")} aria-busy={!!busy}>
    <Toolbar as="header"><h3>{t("Template Studio")}</h3><p>{t("Create a personal template for PowerPoint and HTML. Choose reusable layouts and chart styles. Preview text and chart values are illustrative placeholders.")}</p></Toolbar>
    {onAskBob && <fieldset className="template-studio-assist"><legend>{t("Design with Bob")}</legend><label>{t("Describe your template")}<textarea aria-label={t("Describe your template")} value={brief} maxLength={4000} placeholder={t("For example: a minimal blue and gold template with rounded cards")} onChange={e => setBrief(e.target.value)} /></label><button type="button" disabled={!!busy || bobBusy || !brief.trim()} onClick={() => onAskBob(brief.trim())}>{t(bobBusy ? 'Bob is designing…' : 'Ask Bob to design')}</button><p>{t("Bob creates a draft in this conversation. Refresh drafts, load it here and preview it before saving your reusable template.")}</p>{sessionId && <div className="template-studio-drafts"><button type="button" disabled={!!busy} onClick={() => void refreshDrafts()}>{t("Refresh drafts")}</button><label>{t("Bob draft")}<select aria-label={t("Bob draft")} value={draftPath} onChange={e => setDraftPath(e.target.value)}><option value="">{t("Choose a draft")}</option>{drafts.map(item => <option key={item.path} value={item.path}>{item.config.title}</option>)}</select></label><button type="button" disabled={!!busy || !drafts.some(item => item.path === draftPath)} onClick={() => { const draft = drafts.find(item => item.path === draftPath); if (draft) { editedText.current = { title: true, brand: true }; setValue({ ...structuredClone(draft.config), design: { ...defaultTemplateDesign.design, ...draft.config.design } }); setStarter(''); setError(''); } }}>{t("Load Bob draft")}</button></div>}</fieldset>}
    <div className="template-studio-layout">
      <div className="template-studio-controls">
        <label>{t("Start from")}<select aria-label={t("Start from")} value={starter} disabled={!!busy} onChange={e => void copyStarter(e.target.value)}><option value="">{t("Fresh design")}</option>{templates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>{t("Template name")}<input aria-label={t("Template name")} value={value.title} maxLength={100} onChange={e => update('title', e.target.value)} /></label>
        <label>{t("Brand")}<input aria-label={t("Brand")} value={value.brand} maxLength={100} placeholder={t("Your brand")} onChange={e => update('brand', e.target.value)} /></label>
        <fieldset><legend>{t("Colors")}</legend><div className="template-studio-colors">{colorKeys.map(key => {
          const label = t(key[0].toUpperCase() + key.slice(1));
          return <label key={key}>{label}<div><input type="color" aria-label={t('{0} color', [label])} value={/^#[0-9a-f]{6}$/i.test(value.colors[key]) ? value.colors[key] : '#000000'} onChange={e => update('colors', { ...value.colors, [key]: e.target.value })} /><input aria-label={t('{0} hex', [label])} value={value.colors[key]} maxLength={7} spellCheck={false} onChange={e => update('colors', { ...value.colors, [key]: e.target.value })} /></div></label>;
        })}</div></fieldset>
        <fieldset><legend>{t("Typography")}</legend>{(['heading', 'body'] as const).map(key => <label key={key}>{t(key === 'heading' ? 'Heading font' : 'Body font')}<select aria-label={t(key === 'heading' ? 'Heading font' : 'Body font')} value={value.fonts[key]} onChange={e => update('fonts', { ...value.fonts, [key]: e.target.value })}>{Array.from(new Set(['Calibri', 'Arial', 'Aptos', 'Georgia', value.fonts[key]])).map(font => <option key={font}>{font}</option>)}</select></label>)}</fieldset>
        <fieldset><legend>{t("Shapes and layout")}</legend>
          <label>{t("Card shape")}<select aria-label={t("Card shape")} value={value.design.shape} onChange={e => update('design', { ...value.design, shape: e.target.value as TemplateDesign['design']['shape'] })}><option value="rectangle">{t("Rectangle")}</option><option value="roundedRectangle">{t("Rounded rectangle")}</option><option value="ellipse">{t("Ellipse")}</option></select></label>
          <label>{t("Decoration")}<select aria-label={t("Decoration")} value={value.design.decoration} onChange={e => update('design', { ...value.design, decoration: e.target.value as TemplateDesign['design']['decoration'] })}><option value="none">{t("None")}</option><option value="sidebar">{t("Side bar")}</option><option value="topbar">{t("Top bar")}</option></select></label>
          <label>{t('Border width: {0} pt', [value.design.cardBorderWidth])}<input aria-label={t("Border width")} type="range" min="0" max="4" step="1" value={value.design.cardBorderWidth} onChange={e => update('design', { ...value.design, cardBorderWidth: Number(e.target.value) })} /></label>
          <label>{t("Content layout")}<select aria-label={t("Content layout")} value={value.design.contentLayout} onChange={e => update('design', { ...value.design, contentLayout: e.target.value as TemplateDesign['design']['contentLayout'] })}><option value="cards">{t("Three idea cards")}</option><option value="comparison">{t("Two-column comparison")}</option><option value="timeline">{t("Three-stage timeline")}</option></select></label>
          <label>{t("Chart style")}<select aria-label={t("Chart style")} value={value.design.chartType} onChange={e => update('design', { ...value.design, chartType: e.target.value as TemplateDesign['design']['chartType'] })}><option value="none">{t("No chart")}</option><option value="bar">{t("Bar chart")}</option><option value="line">{t("Line chart")}</option><option value="doughnut">{t("Doughnut chart")}</option></select></label>
        </fieldset>
        <fieldset><legend>{t("HTML interaction")}</legend><label className="template-studio-checkbox"><input type="checkbox" aria-label={t("HTML slide navigation")} checked={value.design.htmlNavigation} onChange={e => update('design', { ...value.design, htmlNavigation: e.target.checked })} />{t("Slide navigation and keyboard controls")}</label><label>{t("Slide transition")}<select aria-label={t("HTML slide transition")} value={value.design.htmlTransition} onChange={e => update('design', { ...value.design, htmlTransition: e.target.value as TemplateDesign['design']['htmlTransition'] })}><option value="none">{t("None")}</option><option value="fade">{t("Fade")}</option><option value="slide">{t("Slide")}</option></select></label><p className="template-studio-hint">{t("Navigation and transitions are HTML only. Motion respects the viewer’s accessibility preferences. PowerPoint keeps editable slides and native charts.")}</p></fieldset>
      </div>
      <div className="template-studio-preview"><div role="tablist" aria-label={t("Preview layout")}>{previewNames.map((name, i) => <button key={deck.slides[i].id} type="button" role="tab" aria-selected={page === i} tabIndex={page === i ? 0 : -1} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? previewNames.length - 1 : (page + (event.key === 'ArrowRight' ? 1 : previewNames.length - 1)) % previewNames.length; setPage(next); const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]'); tabs?.[next]?.focus(); } }} onClick={() => setPage(i)}>{name}</button>)}</div><div ref={preview} role="img" aria-label={t('{0} preview', [previewNames[Math.min(page, previewNames.length - 1)]])} className="template-studio-slide" /><p>{t("Colors, fonts, shapes, layouts and charts work in both formats. HTML navigation and transitions are available in the HTML download. Fonts depend on those installed on the viewing device.")}</p><div className="template-studio-downloads"><button type="button" disabled={!!busy || !!invalid} onClick={() => void download('html')}>{t("Download HTML")}</button><button type="button" disabled={!!busy || !!invalid} onClick={() => void download('pptx')}>{t("Download PowerPoint")}</button></div></div>
    </div>
    {error && <p className="template-studio-error" role="alert">{t(error)}</p>}
    {busy && <p className="template-studio-status" role="status"><span className="template-studio-spinner" aria-hidden="true" />{t(busy)}</p>}
    <footer><button type="button" disabled={!!busy} onClick={onCancel}>{t("Cancel")}</button><button type="button" disabled={!!busy || !!invalid} onClick={() => void save()}>{t("Save template")}</button></footer>
  </section>;
}
