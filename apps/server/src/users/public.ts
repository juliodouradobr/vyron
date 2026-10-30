import { userSettingsSchema, type PublicUser, type UserSettings } from '@nexo/protocol';
import type { Queryable } from '../db';

/** Única forma de expor outro usuário: sem senha, sem status bruto, sem dados de sessão. */
export const PUBLIC_USER_COLUMNS = 'id, username, discriminator, display_name, bio, avatar_id, banner_id, created_at';

export interface PublicUserRow {
  id: string;
  username: string;
  discriminator: string;
  display_name: string;
  bio: string;
  avatar_id: string | null;
  banner_id: string | null;
  created_at: Date;
}

export const toPublicUser = (r: PublicUserRow): PublicUser => ({
  id: r.id,
  username: r.username,
  discriminator: r.discriminator,
  displayName: r.display_name,
  bio: r.bio,
  avatarId: r.avatar_id,
  bannerId: r.banner_id,
  createdAt: new Date(r.created_at).toISOString(),
});

export async function loadPublicUsers(q: Queryable, ids: Iterable<string>): Promise<Map<string, PublicUser>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const { rows } = await q.query<PublicUserRow>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ANY($1::uuid[])`, [list]);
  return new Map(rows.map((r) => [r.id, toPublicUser(r)]));
}

export async function getUserSettings(q: Queryable, userId: string): Promise<UserSettings> {
  const { rows } = await q.query<{ data: unknown }>('SELECT data FROM user_settings WHERE user_id = $1', [userId]);
  return userSettingsSchema.parse(rows[0]?.data ?? {});
}

export async function shareServer(q: Queryable, a: string, b: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM server_members x JOIN server_members y ON x.server_id = y.server_id
     WHERE x.user_id = $1 AND y.user_id = $2 LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

/** true se qualquer um dos dois bloqueou o outro. */
export async function isBlockedEitherWay(q: Queryable, a: string, b: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM relationships WHERE type = 'blocked'
       AND ((user_id = $1 AND target_id = $2) OR (user_id = $2 AND target_id = $1)) LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}
