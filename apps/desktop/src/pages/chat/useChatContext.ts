import { useEffect, useMemo } from 'react';
import { formatTag, Permission, publicOfSelf, serializePermissions, type Channel, type PublicUser, type Role } from '@nexo/protocol';
import { DM_CLIENT_PERMISSIONS } from './constants';
import { useServers } from '../../stores/servers';
import { useSession } from '../../stores/session';
import { useSocial } from '../../stores/social';
import type { Route } from '../../stores/nav';

export interface ChatContext {
  channelId: string;
  kind: 'dm' | 'server';
  serverId: string | null;
  channel: Channel | null;
  title: string;
  topic: string;
  /** Permissões efetivas neste canal (string decimal). */
  perms: string;
  /** Pessoas que podem ser mencionadas/exibidas: membros do servidor ou os dois da DM. */
  users: PublicUser[];
  /** Cor do cargo mais alto de cada membro (servidores). */
  colorOf: (userId: string) => number | null;
  recipient: PublicUser | null;
}

/** Junta o que a tela de chat precisa saber sobre a rota atual (DM ou canal de servidor). */
export function useChatContext(route: Route): ChatContext | null {
  const self = useSession((s) => s.user);
  const dms = useSocial((s) => s.dms);
  const serverId = route.kind === 'server' ? route.serverId : null;
  const detail = useServers((s) => (serverId ? s.details[serverId] : undefined));
  const members = useServers((s) => (serverId ? s.members[serverId] : undefined));

  useEffect(() => {
    if (serverId && !members) void useServers.getState().loadMembers(serverId).catch(() => {});
  }, [serverId, members]);

  return useMemo(() => {
    if (!self) return null;
    const selfPublic = publicOfSelf(self);
    if (route.kind === 'dm') {
      const dm = dms[route.channelId];
      if (!dm) return null;
      return {
        channelId: dm.id,
        kind: 'dm',
        serverId: null,
        channel: null,
        title: dm.recipient.displayName,
        topic: formatTag(dm.recipient),
        perms: serializePermissions(DM_CLIENT_PERMISSIONS),
        users: [selfPublic, dm.recipient],
        colorOf: () => null,
        recipient: dm.recipient,
      };
    }
    if (route.kind === 'server' && route.channelId && detail) {
      const channel = detail.channels.find((c) => c.id === route.channelId);
      if (!channel) return null;
      const rolesById = new Map<string, Role>(detail.roles.map((r) => [r.id, r]));
      const colorOf = (userId: string) => {
        const m = members?.find((x) => x.user.id === userId);
        const colored = (m?.roleIds ?? [])
          .map((id) => rolesById.get(id))
          .filter((r): r is Role => !!r && r.color != null)
          .sort((a, b) => b.position - a.position);
        return colored[0]?.color ?? null;
      };
      return {
        channelId: channel.id,
        kind: 'server',
        serverId: detail.server.id,
        channel,
        title: channel.name,
        topic: channel.topic,
        perms: channel.myPermissions,
        users: members?.map((m) => m.user) ?? [selfPublic],
        colorOf,
        recipient: null,
      };
    }
    return null;
  }, [self, route, dms, detail, members]);
}

export const SEND = Permission.SEND_MESSAGES;
