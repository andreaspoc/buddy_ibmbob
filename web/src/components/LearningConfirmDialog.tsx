import { useEffect, useRef } from 'react';

export function LearningConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="learning-dialog"
      onCancel={event => {
        event.preventDefault();
        onCancel();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="learning-icon-button"
          onClick={onCancel}
          aria-label="Close dialog"
        >
          ×
        </button>
      </header>
      <div className="learning-dialog-body" style={{ padding: '20px 24px' }}>
        <p style={{ margin: '0 0 20px 0', fontSize: '14px', lineHeight: '1.6', color: '#161616' }}>
          {message}
        </p>
        <footer className="learning-dialog-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'learning-button-danger' : 'learning-primary'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
