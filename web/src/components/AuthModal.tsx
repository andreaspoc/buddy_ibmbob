import { brandLogoUrl, brandText } from '../lib/brand';
import { Button, InlineLoading, InlineNotification, PasswordInput, Stack, TextInput } from '@carbon/react';
import { Toolbar } from './Toolbar';
import { t, useLanguage } from "../lib/i18n";
import { LanguageSelector } from './LanguageSelector';
import React, { useEffect, useState } from 'react';
import { fetchAuthStatus } from '../api';
import type { AuthStatus } from '../types';
import { parseSharedConversation } from '../lib/conversationUrl';
import { clearSignInError, signInReturnPath } from '../lib/authUrl';

interface AuthModalProps {
  isOpen?: boolean;
  onSuccess: (user: { username: string; is_admin: boolean }) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen = true, onSuccess }) => {
  const language = useLanguage();
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const kcErr = params.get('keycloak_error');
    if (kcErr) {
      return kcErr.replace(/\+/g, ' ');
    }
    return '';
  });
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // The initial state above retains feedback for this sign-in attempt.
    // Consume its URL marker so retries cannot carry it into a successful login.
    clearSignInError();
    let active = true;
    fetchAuthStatus()
      .then((status) => {
        if (active) setAuthStatus(status);
      })
      .catch(() => {
        if (active) setError('Could not load sign-in options. Please check your network and refresh.');
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // A new installation has no accounts yet, so this form creates the first administrator.
  const firstRun = Boolean(authStatus?.setup_required);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = firstRun ? '/auth/setup' : isRegister && !authStatus?.keycloak_configured ? '/auth/register' : '/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || (isRegister ? 'Registration failed' : 'Sign in failed. Check your credentials.'));
      }

      const status = await fetchAuthStatus();
      if (!status.user) {
        throw new Error('Your session could not be saved. Open the secure sign-in page and try again.');
      }
      onSuccess(status.user);
    } catch (err: any) {
      setError(err.message || 'Authentication error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="buddy-login-viewport" role="main" lang={language} aria-label={t("Buddy Sign In")}>
      <aside className="buddy-brand-showcase" aria-label={brandText("Buddy")}>
        <div className="buddy-brand-signature"><img src={brandLogoUrl()} width="36" height="36" alt="" /><span>{brandText("Buddy")}<span className="buddy-brand-dot">.</span></span></div>
        <div className="buddy-brand-art" aria-hidden="true">
          <div className="buddy-brand-orbit buddy-brand-orbit-one" />
          <div className="buddy-brand-orbit buddy-brand-orbit-two" />
          <div className="buddy-brand-orbit buddy-brand-orbit-three" />
          <div className="buddy-brand-core"><img src={brandLogoUrl()} alt="" /></div>
          <span className="buddy-brand-spark buddy-brand-spark-one" />
          <span className="buddy-brand-spark buddy-brand-spark-two" />
        </div>
        <div className="buddy-brand-message">
          <span className="buddy-brand-eyebrow">{t("AI")}</span>
          <h1>{t("Meet your {0}").split("{0}")[0]}<span>{brandText("Buddy")}</span>{t("Meet your {0}").split("{0}")[1]}</h1>
          <p>{t("Your workspace is ready")}</p>
        </div>
        <div className="buddy-brand-bottom"><span>{brandText("Buddy")}</span><span aria-hidden="true">✦</span></div>
      </aside>
      <div className="buddy-login-shell">
        <Toolbar as="header" className="buddy-login-header">
          <div className="buddy-login-brand"><img src={brandLogoUrl()} width="30" height="30" alt="" /><span><strong>{brandText("Buddy")}</strong></span></div>
          <LanguageSelector />
        </Toolbar>
        {/* RIGHT / AUTH FORM CARD PANEL */}
        <section className="buddy-auth-section">
          <div className="buddy-auth-card">
            {/* Mobile / Card Top Brand Indicator */}
            <div className="buddy-card-header">
              <h2 className="buddy-card-title">{firstRun ? t("Create the administrator account") : isRegister ? t("Create Account") : t("Sign In")}</h2>
              {firstRun && <p>{t('Next you will name your assistant, add a logo and connect a provider.')}</p>}
              {parseSharedConversation(window.location.pathname) && <p>{t('Sign in to your account to view this shared conversation.')}</p>}
            </div>

            {error && <InlineNotification className="buddy-error-banner" kind="error" role="alert" lowContrast
              title={t('Action needed')} subtitle={t(error)} aria-label={t('Dismiss error')}
              onCloseButtonClick={() => setError('')} />}

            {!authStatus && !error && <InlineLoading className="buddy-auth-loading" status="active"
              description={t('Loading authentication options…')} aria-busy="true" />}

            {/* Single Sign-On (Keycloak) Option */}
            {authStatus?.keycloak_configured && (
              <div className="buddy-sso-block">
                <Button kind="tertiary" size="lg"
                  href={`/auth/keycloak/login?next=${encodeURIComponent(signInReturnPath())}`}
                  className="buddy-sso-button" id="auth-keycloak">
                  {t('Sign in with Keycloak')}
                </Button>
              </div>
            )}

            {/* Divider when both SSO and Local are available */}
            {authStatus?.keycloak_configured && authStatus?.local_login_enabled && (
              <div className="buddy-form-divider">
                <span>{t("or use local credentials")}</span>
              </div>
            )}

            {/* Unconfigured Alert */}
            {authStatus && !authStatus.keycloak_configured && !authStatus.local_login_enabled && (
              <InlineNotification className="buddy-auth-unconfigured" kind="warning" role="alert" lowContrast hideCloseButton
                title={t('Action needed')}
                subtitle={t('Authentication is not configured on this instance. Please contact your system administrator.')} />
            )}

            {/* Local Sign-in / Registration Form */}
            {authStatus?.local_login_enabled && (
              <form onSubmit={handleSubmit} className="buddy-auth-form" aria-busy={loading}>
                <Stack gap={6}>
                  <TextInput id="buddy-username" size="lg" labelText={t('Username')}
                    required autoCapitalize="none" autoCorrect="off" enterKeyHint="next" autoComplete="username"
                    value={username} onChange={event => setUsername(event.target.value)}
                    placeholder={t('Enter your username')} />
                  <PasswordInput id="buddy-password" size="lg" labelText={t('Password')}
                    required autoComplete={isRegister || firstRun ? 'new-password' : 'current-password'} enterKeyHint="go"
                    value={password} onChange={event => setPassword(event.target.value)}
                    showPasswordLabel={t('Show password')} hidePasswordLabel={t('Hide password')}
                    placeholder="••••••••••••" />
                  <Button type="submit" kind="primary" size="lg" className="buddy-submit-button" disabled={loading}>
                    {loading ? (isRegister || firstRun ? t('Creating Account…') : t('Signing In…'))
                      : (isRegister || firstRun ? t('Create Account') : t('Sign In'))}
                  </Button>
                </Stack>

                {/* Account toggle when Keycloak is not active */}
                {!authStatus.keycloak_configured && !firstRun && (
                  <div className="buddy-account-actions">
                    <span>{isRegister ? t("Already have an account?") : t("Don't have an account?")}</span>{' '}
                    <Button kind="ghost" size="sm"
                      type="button"
                      onClick={() => {
                        setIsRegister(!isRegister);
                        setError('');
                      }}
                      className="buddy-switch-link"
                    >
                      {isRegister ? t("Sign in") : t("Create one")}
                    </Button>
                  </div>
                )}
              </form>
            )}

          </div>
        </section>
      </div>
    </div>
  );
};
