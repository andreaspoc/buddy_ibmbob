import { useEffect, useState } from 'react';
import { t } from './i18n';

export interface AccessGroup { id: string; name: string }

/** Administrators get every group; everyone else gets only the groups they belong to. */
export function useAccessGroups(): AccessGroup[] {
  const [groups, setGroups] = useState<AccessGroup[]>([]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/access/groups', { credentials: 'same-origin' });
        const body: { items?: AccessGroup[] } = response?.ok ? await response.json() : {};
        if (active) setGroups(body.items ?? []);
      } catch {
        if (active) setGroups([]);
      }
    })();
    return () => { active = false; };
  }, []);
  return groups;
}

/** A deleted group's content is limited to administrators, so its id has no name to show. */
export function audienceLabel(audience: string | undefined, groups: AccessGroup[]): string {
  if (!audience || audience === 'both') return t('Everyone');
  return groups.find(group => group.id === audience)?.name ?? t('Restricted group');
}
