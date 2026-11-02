export interface TemplateDesign {
  title: string; brand: string;
  colors: { primary: string; secondary: string; accent: string; background: string; text: string };
  fonts: { heading: string; body: string };
  design: { shape: 'rectangle' | 'roundedRectangle' | 'ellipse'; decoration: 'none' | 'sidebar' | 'topbar'; cardBorderWidth: number; contentLayout: 'cards' | 'comparison' | 'timeline'; chartType: 'none' | 'bar' | 'line' | 'doughnut'; htmlNavigation: boolean; htmlTransition: 'none' | 'fade' | 'slide' };
}
export const defaultTemplateDesign: TemplateDesign = {
  title: 'My presentation template', brand: 'My brand',
  colors: { primary: '#5627A7', secondary: '#EDE7F6', accent: '#008B8B', background: '#FFFFFF', text: '#211A31' },
  fonts: { heading: 'Calibri', body: 'Calibri' },
  design: { shape: 'roundedRectangle', decoration: 'sidebar', cardBorderWidth: 1, contentLayout: 'cards', chartType: 'none', htmlNavigation: true, htmlTransition: 'fade' },
};
export function templateDesignError(value: TemplateDesign): string {
  if (!value.title.trim()) return 'Enter a template name.';
  if (!value.brand.trim()) return 'Enter a brand name.';
  if (value.title.trim().length > 100 || value.brand.trim().length > 100) return 'Names must be 100 characters or fewer.';
  if (/[\r\n]/.test(value.title + value.brand)) return 'Names must fit on one line.';
  if (Object.values(value.fonts).some(font => !font.trim() || font.length > 80 || !/^[\w ,.-]+$/u.test(font))) return 'Choose a valid font name.';
  if (Object.values(value.colors).some(color => !/^#[0-9a-f]{6}$/i.test(color))) return 'Use a six-digit hex value for every color, for example #5627A7.';
  if (!['cards', 'comparison', 'timeline'].includes(value.design.contentLayout ?? 'cards') || !['none', 'bar', 'line', 'doughnut'].includes(value.design.chartType ?? 'none')) return 'Choose a supported layout and chart style.';
  if (!['none', 'fade', 'slide'].includes(value.design.htmlTransition ?? 'none')) return 'Choose a supported HTML transition.';
  return '';
}
export function createTemplatePreviewDeck(value: TemplateDesign, translate: (text: string) => string = text => text) {
  const { colors: c, fonts: f } = value;
  const d = { ...defaultTemplateDesign.design, ...value.design };
  const text = (content: string, x: number, y: number, w: number, h: number, fontSize = 22, heading = false) => ({ type: 'text', text: content, x, y, w, h, fontSize, color: c.text, bold: heading, style: { fontFamily: heading ? f.heading : f.body } });
  const shape = (x: number, y: number, w: number, h: number, fill: string, shapeName = d.shape) => ({ type: 'shape', shape: shapeName, x, y, w, h, fill, stroke: c.accent, lineWidth: d.cardBorderWidth });
  const base = () => [
    ...(d.decoration === 'sidebar' ? [shape(0, 0, .22, 7.5, c.primary, 'rectangle')] : d.decoration === 'topbar' ? [shape(0, 0, 13.333, .22, c.primary, 'rectangle')] : []),
    text(value.brand || translate('Your brand'), .65, .45, 11, .4, 15),
  ];
  return {
    title: value.title, theme: { colors: { ...c, chartPalette: [c.primary, c.accent, c.secondary] }, fonts: f },
    slides: [
      { id: 'hero', layout: 'hero', title: translate('Presentation title'), background: c.background, elements: [...base(), shape(9.2, 2.1, 2.7, 2.7, c.secondary), text(translate('Presentation title'), .85, 2.1, 8, 1.2, 40, true), text(translate('A clear introduction to your story'), .85, 3.55, 8, .7), text(translate('Subtitle · Presenter'), .85, 5.5, 9, .5, 18)] },
      { id: 'content', layout: d.contentLayout, title: d.contentLayout === 'comparison' ? translate('Compare your options') : d.contentLayout === 'timeline' ? translate('Your roadmap') : translate('Your key ideas'), background: c.background, elements: [...base(), text(d.contentLayout === 'comparison' ? translate('Compare your options') : d.contentLayout === 'timeline' ? translate('Your roadmap') : translate('Your key ideas'), .85, 1.25, 11, .8, 34, true),
        ...(d.contentLayout === 'timeline' ? [shape(2.65, 3.65, 8, .08, c.accent, 'rectangle')] : []),
        ...(d.contentLayout === 'comparison' ? [translate('Option A'), translate('Option B')] : d.contentLayout === 'timeline' ? [translate('Stage 1'), translate('Stage 2'), translate('Stage 3')] : [translate('First idea'), translate('Second idea'), translate('Third idea')]).flatMap((label, i) => {
          const step = d.contentLayout === 'comparison' ? 6.15 : 4.05;
          const width = d.contentLayout === 'comparison' ? 5.45 : 3.65;
          const x = .85 + i * step;
          return [shape(x, 2.65, width, 2.6, c.secondary), text(label, x + .35, 3.05, width - .75, .6, 23, true), text(d.contentLayout === 'comparison' ? translate('Describe strengths and tradeoffs.') : d.contentLayout === 'timeline' ? translate('Add the stage details here.') : translate('Add your supporting message here.'), x + .35, 3.9, width - .75, .85, 19)];
        })] },
      ...(d.chartType !== 'none' ? [{ id: 'chart', layout: 'chart', title: translate('Sample chart'), background: c.background, elements: [...base(), text(translate('Sample chart'), .85, 1.25, 11, .8, 34, true), { type: 'chart', chartType: d.chartType, title: translate('Illustrative sample values'), x: .85, y: 2.3, width: 11.65, height: 3.8, categories: ['A', 'B', 'C'], series: [{ name: translate('Sample'), values: [25, 40, 35], color: c.primary }], showValues: true, axisColor: c.text }, text(translate('Illustrative sample values — replace with your own data'), .85, 6.4, 11.5, .4, 16)] }] : []),
      { id: 'closing', layout: 'closing', title: translate('Next steps'), background: c.background, elements: [...base(), shape(9.2, 2.1, 2.7, 2.7, c.primary), text(translate('Next steps'), .85, 2.1, 8, 1.2, 40, true), text(translate('Your closing message and call to action'), .85, 3.7, 8, 1), text(translate('Thank you'), .85, 5.5, 8, .5, 20)] },
    ],
  };
}
export function createTemplateHtml(value: TemplateDesign, slides: string[], options: { language?: 'en' | 'el' | 'hi' | 'mt'; translate?: (text: string) => string } = {}): string {
  const translate = options.translate ?? (text => text);
  const language = options.language ?? 'en';
  const escape = (s: string) => s.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  const navigation = value.design.htmlNavigation !== false;
  const transition = value.design.htmlTransition ?? 'none';
  const animation = transition === 'fade' ? 'templateFade .35s ease-out' : transition === 'slide' ? 'templateSlide .35s ease-out' : 'none';
  const controls = navigation ? `<nav aria-label="${escape(translate('Slide navigation'))}"><button id="previous" type="button">${escape(translate('Previous'))}</button><span id="position" aria-live="polite"></span><button id="next" type="button">${escape(translate('Next'))}</button></nav>` : '';
  const script = navigation ? `<script>(()=>{const slides=[...document.querySelectorAll('main section')],previous=document.getElementById('previous'),next=document.getElementById('next'),position=document.getElementById('position');let index=0;const show=i=>{index=Math.max(0,Math.min(slides.length-1,i));slides.forEach((slide,n)=>slide.hidden=n!==index);previous.disabled=index===0;next.disabled=index===slides.length-1;position.textContent=(index+1)+' / '+slides.length};previous.onclick=()=>show(index-1);next.onclick=()=>show(index+1);document.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();show(index+(event.key==='ArrowRight'?1:-1))}if(event.key==='Home')show(0);if(event.key==='End')show(slides.length-1)});show(0)})()</script>` : '';
  return `<!doctype html><html lang="${escape(language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(value.title)}</title><style>body{margin:0;background:#202026;font-family:Arial,sans-serif}main{max-width:1280px;margin:auto;padding:24px}section{margin:0 0 24px;aspect-ratio:16/9}section[hidden]{display:none}section:not([hidden]){animation:${animation}}@keyframes templateFade{from{opacity:0}to{opacity:1}}@keyframes templateSlide{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}@media(prefers-reduced-motion:reduce){section:not([hidden]){animation:none}}svg{width:100%;height:100%;display:block}nav{display:flex;justify-content:center;align-items:center;gap:18px;padding:14px;color:white}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:3px solid ${value.colors.accent};outline-offset:3px}@media print{body{background:white}main{padding:0}section,section[hidden]{display:block;break-after:page;margin:0;animation:none!important;transform:none!important}nav{display:none}}@page{size:landscape;margin:0}</style><main>${slides.map(svg => `<section>${svg}</section>`).join('')}</main>${controls}${script}</html>`;
}
