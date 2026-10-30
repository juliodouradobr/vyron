import { useMemo } from 'react';
import { publicOfSelf, type PublicUser } from '@nexo/protocol';
import { useServers } from '../../stores/servers';
import { useSession } from '../../stores/session';
import { useSocial } from '../../stores/social';

/** Todos os usuários conhecidos pelo cliente (membros, DMs, amigos e você), por id. */
export function useUserMap(): Map<string, PublicUser> {
  const members = useServers((s) => s.members);
  const dms = useSocial((s) => s.dms);
  const rels = useSocial((s) => s.relationships);
  const self = useSession((s) => s.user);
  return useMemo(() => {
    const m = new Map<string, PublicUser>();
    for (const list of Object.values(members)) for (const x of list) m.set(x.user.id, x.user);
    for (const d of Object.values(dms)) m.set(d.recipient.id, d.recipient);
    for (const r of Object.values(rels)) m.set(r.user.id, r.user);
    if (self) m.set(self.id, publicOfSelf(self));
    return m;
  }, [members, dms, rels, self]);
}
