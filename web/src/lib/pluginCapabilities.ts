import { useAppRegistry } from './appRegistry';
/** Compatibility hook for existing Office integration consumers. */
export function usePluginCapabilities(account?: string | boolean) {
  const registry = useAppRegistry(account);
  return { office: registry.apps.some(app => app.id === 'office'), people: registry.apps.some(app => app.id === 'people') };
}
