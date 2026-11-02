import { t } from '../lib/i18n';
import './DeleteQuestionButton.css';

export function DeleteQuestionButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <button type="button" className="question-delete-icon" disabled={disabled} onClick={onClick} aria-label={t('Delete question')} title={t('Delete question')}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
  </button>;
}
