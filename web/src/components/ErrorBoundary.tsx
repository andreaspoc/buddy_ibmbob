import { t } from "../lib/i18n";
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  name?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`ErrorBoundary caught an error in [${this.props.name || 'Component'}]:`, error, errorInfo);
  }

  public reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public override render() {
    if (this.state.hasError) {
      const moduleLoadFailed = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .+ failed/i.test(this.state.error?.message || '');
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error || new Error('Unknown error'), this.reset);
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          className="error-boundary-card"
          style={{
            padding: '16px 20px',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: '10px',
            margin: '12px 0',
            color: '#991b1b',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <strong style={{ fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span aria-hidden="true">⚠️</span> {moduleLoadFailed ? t("Refresh to load the latest application") : <>{t("Something went wrong displaying")}{this.props.name || t("this content")}</>}
            </strong>
            <button
              type="button"
              onClick={moduleLoadFailed ? () => window.location.reload() : this.reset}
              style={{
                background: '#ef4444',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t(moduleLoadFailed ? "Refresh application" : "Retry")}</button>
          </div>
          <p style={{ margin: 0, fontSize: '12px', color: '#b91c1c', fontFamily: 'monospace' }}>
            {moduleLoadFailed ? t("A required application file could not be loaded. Refresh to get the latest version. Save any unsaved work before refreshing.") : this.state.error?.message || t("Unexpected application error")}
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
