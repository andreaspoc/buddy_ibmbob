import type { WorkKind } from './ProjectsWorkspace';

export const statuses: Record<WorkKind, string[]> = {
  milestone: ['todo', 'in_progress', 'blocked', 'done'],
  task: ['todo', 'in_progress', 'blocked', 'done'],
  risk: ['open', 'mitigating', 'resolved'],
  issue: ['open', 'in_progress', 'resolved'],
  decision: ['proposed', 'approved', 'declined'],
  deliverable: ['draft', 'in_development', 'quality_review', 'accepted'],
  lesson: ['identified', 'logged', 'applied'],
};
export const words = (value: string) => value === 'todo' ? 'To do' : value.replaceAll('_', ' ');
