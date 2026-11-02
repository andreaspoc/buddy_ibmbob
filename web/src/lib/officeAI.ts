export type OfficeAIConfig = {
  username: string;
  storage: { version: number; providers: Record<string, unknown>; models: Array<{ id: string }>; customProviders: Record<string, string> };
  actions: Record<string, { model: string }>;
};

/** Configure the installed ONLYOFFICE provider without exposing server credentials. */
export function configureOfficeAI(config: OfficeAIConfig) {
  const storageKey = 'onlyoffice_ai_plugin_storage_key';
  const actionKey = 'onlyoffice_ai_actions_key';
  try {
    const previous = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const existing = previous.version === config.storage.version ? previous : {};
    const storage = {
      ...existing, version: config.storage.version,
      providers: { ...existing.providers, ...config.storage.providers },
      models: [...(Array.isArray(existing.models) ? existing.models.filter((model: { id: string }) => model.id !== 'bob-acp') : []), ...config.storage.models],
      customProviders: { ...existing.customProviders, ...config.storage.customProviders },
    };
    const priorUser = localStorage.getItem('buddy-office-ai-user');
    if (priorUser !== config.username) {
      // The native plugin stores chat in the browser; never show another account's chat.
      localStorage.removeItem('onlyoffice_ai_chat_state');
      localStorage.setItem('buddy-office-ai-user', config.username);
    }
    localStorage.setItem(storageKey, JSON.stringify(storage));
    const actions = JSON.parse(localStorage.getItem(actionKey) || '{}');
    for (const [name, action] of Object.entries(config.actions)) actions[name] = { ...actions[name], ...action };
    localStorage.setItem(actionKey, JSON.stringify(actions));
  } catch {
    throw new Error('Allow browser storage to enable Bob inside the Office editor.');
  }
}
