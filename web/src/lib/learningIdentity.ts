/** Internal account IDs remain request keys, never the visible person label. */
export function learningUserName(user: { username?: string; display_name?: string; is_admin?: boolean }) {
  const name = user.display_name?.trim();
  const internal = /^kc-[a-f0-9]{40}$/i;
  if (name && !internal.test(name)) return name;
  if (user.username && !internal.test(user.username)) return user.username;
  return user.is_admin ? 'Administrator' : 'Learner';
}
