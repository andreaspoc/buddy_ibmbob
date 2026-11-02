import { brandLogoUrl, brandText } from '../lib/brand';
import { Toolbar } from './Toolbar';
import type { ReactNode } from 'react';

/** A shared branded header for workspace pages and configuration dialogs. */
export function WorkspaceSectionHeader({ title, eyebrow, description, titleId, level = 'h2', actions, compact = false }: {
  title: string; eyebrow?: string; description?: string; titleId?: string;
  level?: 'h1' | 'h2'; actions?: ReactNode; compact?: boolean;
}) {
  const Heading = level;
  return <Toolbar as="header" className={`buddy-section-header${compact ? ' is-compact' : ''}`}>
    <div className="buddy-section-copy">
      <WorkspaceBrand />
      {eyebrow && <span className="buddy-section-eyebrow">{eyebrow}</span>}
      <Heading id={titleId} className="buddy-section-title">{title}</Heading>
      {description && <p className="buddy-section-description">{description}</p>}
    </div>
    {actions && <div className="buddy-section-actions">{actions}</div>}
  </Toolbar>;
}

export function WorkspaceBrand({ className = '' }: { className?: string }) {
  return <div className={`buddy-section-brand ${className}`}><img src={brandLogoUrl()} width="22" height="22" alt="" aria-hidden="true" /><span>{brandText("Buddy")}<span> {brandText("Buddy")}</span></span></div>;
}
