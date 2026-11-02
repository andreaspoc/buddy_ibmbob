/** Inline diagrams fit card width and grow vertically instead of shrinking to a viewport. */
export function diagramWidthFit(width: number, height: number, availableWidth: number, padding = 20, centered = false) {
  const zoom = Math.min(1, Math.max(1, availableWidth - padding * 2) / Math.max(1, width));
  return { zoom, x: centered ? Math.max(padding, (availableWidth - width * zoom) / 2) : padding, y: padding, height: Math.max(200, Math.ceil(Math.max(1, height) * zoom + padding * 2)) };
}
