/**
 * Validates whether an HTML presentation is fully generated and ready to display.
 * Requires proper closed tags (</body>, </html>) and presentation slide structure.
 */
export const isCompleteHtmlDeck = (html: string): boolean => {
  if (!html || typeof html !== 'string') return false;
  const trimmed = html.trim();
  if (trimmed.length < 250) return false;
  const lower = trimmed.toLowerCase();

  // Must have closed body and html tags
  if (!lower.includes('</html>') || !lower.includes('</body>')) {
    return false;
  }

  // Must have at least one slide container
  const hasSlide =
    lower.includes('class="slide"') ||
    lower.includes("class='slide'") ||
    lower.includes('class="slide ') ||
    lower.includes("class='slide ") ||
    lower.includes('<section') ||
    lower.includes('id="deck"');

  return hasSlide;
};


/** Saved uploads are complete files, even when they use another slide framework
 * or omit closing tags that the browser can recover. */
export function shouldWaitForHtmlDeck(html: string, isWorking: boolean, officeFileId?: string): boolean {
  return !!html && !officeFileId && !isWorking && !isCompleteHtmlDeck(html);
}
