import { randomInt } from 'node:crypto';
import { ErrorCode, parseTag, type PresenceStatus, type SelfUser } from '@nexo/protocol';
import type { Queryable } from '../db';
import { AppError } from '../http/errors';

export interface UserRow {
  id: string;
  username: string;
  discriminator: string;
  display_name: string;
  bio: string;
  avatar_id: string | null;
  banner_id: string | null;
  password_hash: string;
  status: PresenceStatus;
  failed_logins: number;
  locked_until: Date | null;
  created_at: Date;
}

export const toSelfUser = (r: UserRow): SelfUser => ({
  id: r.id,
  username: r.username,
  discriminator: r.discriminator,
  displayName: r.display_name,
  bio: r.bio,
  avatarId: r.avatar_id,
  bannerId: r.banner_id,
  status: r.status,
  createdAt: new Date(r.created_at).toISOString(),
});

/**
 * Resolve um identificador digitado ("Nome#12345" ou só "Nome") para uma conta.
 * Só o nome é aceito quando há exatamente uma conta com ele; com mais de uma, pede o identificador completo
 * (nunca escolhe uma conta por conta própria).
 */
export async function findUserByTag(db: Queryable, identifier: string): Promise<UserRow | undefined> {
  const tag = parseTag(identifier);
  if (!tag) return undefined;
  if (tag.discriminator) {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1) AND discriminator = $2', [
      tag.name,
      tag.discriminator,
    ]);
    return rows[0];
  }
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 2', [tag.name]);
  if (rows.length > 1) {
    throw new AppError(409, ErrorCode.AMBIGUOUS_USERNAME, 'Há mais de uma conta com esse nome. Informe o identificador completo, como Nome#00000.');
  }
  return rows[0];
}

/** Quantas contas podem compartilhar um nome antes de recusarmos novos cadastros com ele. */
export const MAX_ACCOUNTS_PER_NAME = 90_000;

/**
 * Sorteia um discriminador livre para o nome. Aleatório (e não sequencial) para não revelar quantas contas
 * usam o nome nem a ordem de criação. Devolve null se o nome estiver praticamente esgotado.
 */
export async function pickDiscriminator(db: Queryable, username: string): Promise<string | null> {
  const { rows } = await db.query<{ discriminator: string }>('SELECT discriminator FROM users WHERE lower(username) = lower($1)', [
    username,
  ]);
  if (rows.length >= MAX_ACCOUNTS_PER_NAME) return null;
  const taken = new Set(rows.map((r) => r.discriminator));
  for (let i = 0; i < 50; i++) {
    const d = String(randomInt(1, 100_000)).padStart(5, '0');
    if (!taken.has(d)) return d;
  }
  return null;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}
