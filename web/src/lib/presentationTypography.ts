import typography from './presentationTypography.scss?inline';

/** Apply the shared slide scale to previews and portable HTML, once. */
export function withPresentationTypography(source: string): string {
  if (!source) return source;
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.body.setAttribute('data-buddy-presentation', 'true');
  let style = doc.getElementById('buddy-presentation-typography');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'buddy-presentation-typography';
    doc.head.append(style);
  }
  style.textContent = typography;
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
