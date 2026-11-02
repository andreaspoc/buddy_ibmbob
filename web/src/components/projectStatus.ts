/** Terminal project and work-item states shared by timeline filtering and styling. */
export function isClosedStatus(status: string): boolean {
  return ['completed', 'done', 'resolved', 'approved', 'declined', 'accepted', 'applied'].includes(status.toLowerCase());
}
