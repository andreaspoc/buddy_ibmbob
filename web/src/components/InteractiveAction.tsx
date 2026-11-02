import { postWithPersonalDataReview } from '../lib/personalDataReview';
import { useRef, useState, useId } from 'react';
import { t } from '../lib/i18n';

export function InteractiveAction({
  title: initialTitle,
  body: initialBody,
  operation,
  sessionId,
  disabled = false,
}: {
  title: string;
  body: string;
  operation: 'save_note' | 'email_note';
  sessionId?: string;
  disabled?: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [recipient, setRecipient] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const formId = useId();

  async function submit() {
    if (lock.current || disabled || !sessionId || result) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      const data = await postWithPersonalDataReview('/api/interactive/actions', {
        session_id: sessionId,
        action: operation,
        title,
        body,
        ...(operation === 'email_note' ? { recipient } : {}),
      }, t('Could not complete this action.'));
      if (!data) return;
      setResult(data.message);
      if (operation === 'save_note') {
        window.dispatchEvent(new Event('buddy-notes-changed'));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Could not complete this action.'));
    } finally {
      lock.current = false;
      setSending(false);
    }
  }

  const isEmail = operation === 'email_note';
  const actionTitle = isEmail ? t('Send Markdown Note via Email') : t('Save Draft to My Notes');
  const actionDescription = isEmail
    ? t('Review the note content and recipient email address before dispatching.')
    : t('Review this draft note and save it directly to your personal notes collection.');

  return (
    <form className="ia-action-form" onSubmit={event => { event.preventDefault(); void submit(); }} aria-labelledby={`${formId}-title`}>
      {/* Carbon Form Header */}
      <header className="ia-action-header">
        <div className="ia-action-meta">
          <span className="cds--tag cds--tag--purple">
            {isEmail ? '✉ ' + t('Email Action') : '✎ ' + t('Notes Action')}
          </span>
          {sessionId && (
            <span className="ia-action-session-tag">
              ● {t('Active Session')}
            </span>
          )}
        </div>
        <h4 id={`${formId}-title`} className="ia-action-title">{actionTitle}</h4>
        <p className="ia-action-description">{actionDescription}</p>
      </header>

      {/* Carbon Form Controls */}
      <fieldset className="ia-action-fieldset" disabled={disabled || sending || Boolean(result) || !sessionId}>
        <div className="cds--form-item ia-form-item">
          <label className="cds--label" htmlFor={`${formId}-title-input`}>
            {t('Note Title')}
          </label>
          <input
            id={`${formId}-title-input`}
            className="cds--text-input ia-text-input"
            required
            maxLength={160}
            value={title}
            onChange={event => setTitle(event.target.value)}
            placeholder={t('Enter note title…')}
          />
        </div>

        <div className="cds--form-item ia-form-item">
          <label className="cds--label" htmlFor={`${formId}-body-input`}>
            {t('Note Content (Markdown)')}
          </label>
          <textarea
            id={`${formId}-body-input`}
            className="cds--text-area ia-textarea"
            required
            maxLength={20000}
            rows={7}
            value={body}
            onChange={event => setBody(event.target.value)}
            placeholder={t('Write note content in Markdown…')}
          />
        </div>

        {isEmail && (
          <div className="cds--form-item ia-form-item">
            <label className="cds--label" htmlFor={`${formId}-recipient-input`}>
              {t('Recipient Email Address')}
            </label>
            <input
              id={`${formId}-recipient-input`}
              className="cds--text-input ia-text-input"
              type="email"
              required
              maxLength={254}
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="user@example.com"
            />
            <div className="cds--form__helper-text ia-helper-text">
              {t('Attachment')}: <strong>{title || t('Note')}.md</strong>
            </div>
          </div>
        )}

        {!result && (
          <div className="ia-action-submit-row">
            <button
              type="submit"
              className="cds--btn cds--btn--primary ia-submit-btn"
              disabled={disabled || sending || !sessionId || !title.trim() || !body.trim() || (isEmail && !recipient.trim())}
            >
              <span>{t(sending ? 'Processing…' : isEmail ? 'Send Email Attachment' : 'Save to My Notes')}</span>
              <span aria-hidden="true" className="ia-btn-arrow">→</span>
            </button>
          </div>
        )}
      </fieldset>

      {/* Carbon Feedback Notifications */}
      {!sessionId && (
        <div className="cds--inline-notification cds--inline-notification--info ia-status-box" role="status">
          <div className="cds--inline-notification__details">
            <p className="cds--inline-notification__subtitle">{t('Open this conversation in active chat to execute this action.')}</p>
          </div>
        </div>
      )}

      {result && (
        <div className="cds--inline-notification cds--inline-notification--success ia-status-box" role="status">
          <div className="cds--inline-notification__details">
            <p className="cds--inline-notification__title">✓ {t('Success')}</p>
            <p className="cds--inline-notification__subtitle">{result}</p>
          </div>
        </div>
      )}

      {error && (
        <div className="cds--inline-notification cds--inline-notification--error ia-status-box" role="alert">
          <div className="cds--inline-notification__details">
            <p className="cds--inline-notification__title">{t('Error')}</p>
            <p className="cds--inline-notification__subtitle">{error}</p>
          </div>
        </div>
      )}
    </form>
  );
}
