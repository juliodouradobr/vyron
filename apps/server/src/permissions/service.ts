import {
  Permission,
  computePermissions,
  hasPermission,
  parsePermissions,
  type Overwrite,
} from '@nexo/protocol';
import type { Queryable } from '../db';
import { forbidden, notFound } from '../http/errors';

export interface ServerRow {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  created_at: Date;
}

export interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  color: number | null;
  permissions: string;
  position: number;
  is_default: boolean;
}

export interface ChannelRow {
  id: string;
  server_id: string | null;
  type: 'category' | 'text' | 'voice' | 'announcement' | 'dm';
  name: string;
  topic: string;
  parent_id: string | null;
  position: number;
  last_message_id: string | null;
  created_at: Date;
}

export interface OverwriteRow {
  channel_id: string;
  target_type: 'role' | 'member';
  target_id: string;
  allow: string;
  deny: string;
}

/** Tudo o que é preciso para decidir permissões de um membro em um servidor. */
export interface MemberContext {
  server: ServerRow;
  userId: string;
  isOwner: boolean;
  roles: RoleRow[];
  everyone: RoleRow;
  memberRoleIds: string[];
  /** Permissões no nível do servidor (sem overwrites de canal). */
  basePerms: bigint;
  /** Posição do cargo mais alto (proprietário = infinito). */
  top: number;
}

export const ROLE_COLUMNS = 'id, server_id, name, color, permissions::text AS permissions, position, is_default';
export const OVERWRITE_COLUMNS = 'channel_id, target_type, target_id, allow::text AS allow, deny::text AS deny';

/** Permissões fixas de quem participa de uma conversa privada. */
export const DM_PERMISSIONS =
  Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.ATTACH_FILES | Permission.ADD_REACTIONS;

const ow = (o: OverwriteRow): Overwrite => ({ allow: parsePermissions(o.allow), deny: parsePermissions(o.deny) });

export async function loadServer(q: Queryable, serverId: string): Promise<ServerRow> {
  const { rows } = await q.query<ServerRow>('SELECT * FROM servers WHERE id = $1', [serverId]);
  if (!rows[0]) throw notFound('Servidor não encontrado.');
  return rows[0];
}

export async function loadRoles(q: Queryable, serverId: string): Promise<RoleRow[]> {
  const { rows } = await q.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM roles WHERE server_id = $1 ORDER BY position DESC, id`, [serverId]);
  return rows;
}

/**
 * Carrega o contexto do membro. Para quem não é membro, responde 404 (e não 403) para não
 * revelar a existência de servidores privados.
 */
export async function memberContext(q: Queryable, serverId: string, userId: string): Promise<MemberContext> {
  const server = await loadServer(q, serverId);
  const { rows: member } = await q.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
  if (member.length === 0) throw notFound('Servidor não encontrado.');
  const roles = await loadRoles(q, serverId);
  const { rows: mr } = await q.query<{ role_id: string }>('SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2', [
    serverId,
    userId,
  ]);
  const memberRoleIds = mr.map((r) => r.role_id);
  return buildContext(server, userId, roles, memberRoleIds);
}

function buildContext(server: ServerRow, userId: string, roles: RoleRow[], memberRoleIds: string[]): MemberContext {
  const everyone = roles.find((r) => r.is_default);
  if (!everyone) throw new Error(`servidor ${server.id} sem cargo padrão`);
  const mine = roles.filter((r) => memberRoleIds.includes(r.id));
  const isOwner = server.owner_id === userId;
  const basePerms = computePermissions({
    isOwner,
    everyone: parsePermissions(everyone.permissions),
    memberRoles: mine.map((r) => parsePermissions(r.permissions)),
  });
  const top = isOwner ? Number.POSITIVE_INFINITY : Math.max(0, ...mine.map((r) => r.position));
  return { server, userId, isOwner, roles, everyone, memberRoleIds, basePerms, top };
}

/** Permissões do membro em um canal, aplicando os overwrites na ordem documentada. */
export function channelPermissions(ctx: MemberContext, overwrites: OverwriteRow[]): bigint {
  const forEveryone = overwrites.find((o) => o.target_type === 'role' && o.target_id === ctx.everyone.id);
  const forRoles = overwrites.filter((o) => o.target_type === 'role' && ctx.memberRoleIds.includes(o.target_id));
  const forMember = overwrites.find((o) => o.target_type === 'member' && o.target_id === ctx.userId);
  return computePermissions({
    isOwner: ctx.isOwner,
    everyone: parsePermissions(ctx.everyone.permissions),
    memberRoles: ctx.roles.filter((r) => ctx.memberRoleIds.includes(r.id)).map((r) => parsePermissions(r.permissions)),
    channel: { everyone: forEveryone && ow(forEveryone), roles: forRoles.map(ow), member: forMember && ow(forMember) },
  });
}

export async function loadOverwrites(q: Queryable, channelIds: string[]): Promise<OverwriteRow[]> {
  if (channelIds.length === 0) return [];
  const { rows } = await q.query<OverwriteRow>(`SELECT ${OVERWRITE_COLUMNS} FROM channel_overwrites WHERE channel_id = ANY($1::uuid[])`, [
    channelIds,
  ]);
  return rows;
}

export async function loadChannel(q: Queryable, channelId: string): Promise<ChannelRow> {
  const { rows } = await q.query<ChannelRow>('SELECT * FROM channels WHERE id = $1', [channelId]);
  if (!rows[0]) throw notFound('Canal não encontrado.');
  return rows[0];
}

export interface ChannelAccess {
  channel: ChannelRow;
  perms: bigint;
  /** Presente para canais de servidor. */
  ctx?: MemberContext;
  /** Presente para conversas privadas: os dois participantes. */
  dmRecipients?: string[];
}

/**
 * Resolve o acesso de um usuário a um canal. Sem VIEW_CHANNEL o canal "não existe" (404),
 * para não vazar nomes de canais privados.
 */
export async function channelAccess(q: Queryable, channelId: string, userId: string): Promise<ChannelAccess> {
  const channel = await loadChannel(q, channelId);
  if (channel.type === 'dm') {
    const { rows } = await q.query<{ user_id: string }>('SELECT user_id FROM dm_recipients WHERE channel_id = $1', [channelId]);
    const recipients = rows.map((r) => r.user_id);
    if (!recipients.includes(userId)) throw notFound('Canal não encontrado.');
    return { channel, perms: DM_PERMISSIONS, dmRecipients: recipients };
  }
  const ctx = await memberContext(q, channel.server_id!, userId).catch(() => {
    throw notFound('Canal não encontrado.');
  });
  const perms = channelPermissions(ctx, await loadOverwrites(q, [channel.id]));
  if (!hasPermission(perms, Permission.VIEW_CHANNEL)) throw notFound('Canal não encontrado.');
  return { channel, perms, ctx };
}

export function requirePerm(perms: bigint, needed: bigint, message?: string): void {
  if (!hasPermission(perms, needed)) throw forbidden(message);
}

/** IDs dos membros que podem ver o canal — destino dos eventos em tempo real. */
export async function channelViewers(q: Queryable, channel: ChannelRow): Promise<string[]> {
  if (channel.type === 'dm') {
    const { rows } = await q.query<{ user_id: string }>('SELECT user_id FROM dm_recipients WHERE channel_id = $1', [channel.id]);
    return rows.map((r) => r.user_id);
  }
  const server = await loadServer(q, channel.server_id!);
  const roles = await loadRoles(q, server.id);
  const overwrites = await loadOverwrites(q, [channel.id]);
  const { rows } = await q.query<{ user_id: string; role_ids: string[] | null }>(
    `SELECT m.user_id, array_remove(array_agg(mr.role_id), NULL) AS role_ids
       FROM server_members m
       LEFT JOIN member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
      WHERE m.server_id = $1
      GROUP BY m.user_id`,
    [server.id],
  );
  return rows
    .filter((m) => {
      const ctx = buildContext(server, m.user_id, roles, m.role_ids ?? []);
      return hasPermission(channelPermissions(ctx, overwrites), Permission.VIEW_CHANNEL);
    })
    .map((m) => m.user_id);
}

export async function serverMemberIds(q: Queryable, serverId: string): Promise<string[]> {
  const { rows } = await q.query<{ user_id: string }>('SELECT user_id FROM server_members WHERE server_id = $1', [serverId]);
  return rows.map((r) => r.user_id);
}

/** Posição mais alta entre os cargos de um membro (proprietário = infinito). */
export async function memberTop(q: Queryable, server: ServerRow, userId: string): Promise<number> {
  if (server.owner_id === userId) return Number.POSITIVE_INFINITY;
  const { rows } = await q.query<{ top: number | null }>(
    `SELECT max(r.position) AS top FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = $1 AND mr.user_id = $2`,
    [server.id, userId],
  );
  return rows[0]?.top ?? 0;
}
