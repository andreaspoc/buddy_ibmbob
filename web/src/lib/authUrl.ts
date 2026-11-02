/** Login feedback is transient; it must not become part of workspace links. */
export function withoutSignInError(url: URL): URL {
  url.searchParams.delete('keycloak_error');
  return url;
}

export function clearSignInError(): void {
  const url = withoutSignInError(new URL(window.location.href));
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

export function signInReturnPath(): string {
  const url = withoutSignInError(new URL(window.location.href));
  return url.pathname + url.search;
}
