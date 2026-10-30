import { serializePermissions, parsePermissions, type Channel, type Role, type ServerDetail, type ServerSummary } from '@nexo/protocol';
import type { Queryable } from '../db';
import {
  channelPermissions,
  loadOverwrites,
  memberContext,
  type ChannelRow,
  type MemberContext,
  type OverwriteRow,
  type RoleRow,
  type ServerRow,
} from '../permissions/service';
import { hasPermission, Permission } from '@nexo/protocol';

export const toServerSummary = (s: ServerRow): ServerSummary => ({
  id: s.id,
  name: s.name,
  description: s.description,
  ownerId: s.owner_id,
});

export const toRole = (r: RoleRow): Role => ({
  id: r.id,
  name: r.name,
  color: r.color,
  permissions: serializePermissions(parsePermissions(r.permissions)),
  position: r.position,
  isDefault: r.is_default,
});

export function toChannel(c: ChannelRow, overwrites: OverwriteRow[], myPermissions: bigint): Channel {
  return {
    id: c.id,
    serverId: c.server_id,
    type: c.type,
    name: c.name,
    topic: c.topic,
    parentId: c.parent_id,
    position: c.position,
    lastMessageId: c.last_message_id,
    overwrites: overwrites
      .filter((o) => o.channel_id === c.id)
      .map((o) => ({ targetType: o.target_type, targetId: o.target_id, allow: o.allow, deny: o.deny })),
    myPermissions: serializePermissions(myPermissions),
  };
}

/** Canais que o membro enxerga. Categorias aparecem se o membro vê a categoria ou algum canal dentro dela. */
export async function visibleChannels(q: Queryable, ctx: MemberContext): Promise<Channel[]> {
  const { rows } = await q.query<ChannelRow>('SELECT * FROM channels WHERE server_id = $1 ORDER BY position, id', [ctx.server.id]);
  const overwrites = await loadOverwrites(
    q,
    rows.map((r) => r.id),
  );
  const withPerms = rows.map((c) => ({ c, p: channelPermissions(ctx, overwrites.filter((o) => o.channel_id === c.id)) }));
  const visible = withPerms.filter(({ c, p }) => {
    if (hasPermission(p, Permission.VIEW_CHANNEL)) return true;
    return c.type === 'category' && withPerms.some((x) => x.c.parent_id === c.id && hasPermission(x.p, Permission.VIEW_CHANNEL));
  });
  return visible.map(({ c, p }) => toChannel(c, overwrites, p));
}

export async function serverDetail(q: Queryable, serverId: string, userId: string): Promise<ServerDetail> {
  const ctx = await memberContext(q, serverId, userId);
  const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM server_members WHERE server_id = $1', [serverId]);
  return {
    server: toServerSummary(ctx.server),
    roles: ctx.roles.map(toRole),
    channels: await visibleChannels(q, ctx),
    myPermissions: serializePermissions(ctx.basePerms),
    myRoleIds: ctx.memberRoleIds,
    memberCount: rows[0]?.n ?? 0,
  };
}
