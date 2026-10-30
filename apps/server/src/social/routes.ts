import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { friendRequestSchema, type DmChannel, type Relationship, type RelationshipType } from '@nexo/protocol';
import { authOf, requireAuth } from '../auth/guard';
import type { Queryable } from '../db';
import { AppError, forbidden, notFound, parseBody } from '../http/errors';
import { ErrorCode } from '@nexo/protocol';
import { uuidv7 } from '../lib/ids';
import {
  PUBLIC_USER_COLUMNS,
  getUserSettings,
  isBlockedEitherWay,
  loadPublicUsers,
  shareServer,
  toPublicUser,
  type PublicUserRow,
} from '../users/public';
import { findUserByTag } from '../users/repo';

const userIdParams = z.object({ userId: z.string().uuid() });
const openDmSchema = z.object({ recipientId: z.string().uuid() });

interface RelRow {
  target_id: string;
  type: RelationshipType;
  created_at: Date;
}

/** Mesma resposta para "não aceita pedidos" e "bloqueou você": não revelar bloqueios. */
const cannotRequest = () => forbidden('Não foi possível enviar o pedido de amizade para essa pessoa.');

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  const { db, hub, dispatcher } = app;
  app.addHook('preHandler', requireAuth);

  async function relationship(q: Queryable, userId: string, targetId: string): Promise<Relationship | null> {
    const { rows } = await q.query<RelRow>('SELECT target_id, type, created_at FROM relationships WHERE user_id = $1 AND target_id = $2', [
      userId,
      targetId,
    ]);
    if (!rows[0]) return null;
    const users = await loadPublicUsers(q, [targetId]);
    const user = users.get(targetId);
    return user ? { user, type: rows[0].type, since: new Date(rows[0].created_at).toISOString() } : null;
  }

  /** Envia a cada lado a sua visão da relação (ou a remoção, se não houver mais nada). */
  async function notifyRelationship(a: string, b: string) {
    for (const [viewer, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const rel = await relationship(db, viewer, other);
      dispatcher.toUsers([viewer], rel ? { type: 'RELATIONSHIP_UPSERT', relationship: rel } : { type: 'RELATIONSHIP_REMOVE', userId: other });
    }
  }

  function sharePresence(a: string, b: string) {
    dispatcher.toUsers([a], { type: 'PRESENCE_UPDATE', userId: b, status: hub.presenceOf(b) });
    dispatcher.toUsers([b], { type: 'PRESENCE_UPDATE', userId: a, status: hub.presenceOf(a) });
  }

  app.get('/users/@me/relationships', async (req): Promise<Relationship[]> => {
    const me = authOf(req).user.id;
    const { rows } = await db.query<RelRow>('SELECT target_id, type, created_at FROM relationships WHERE user_id = $1 ORDER BY created_at', [me]);
    const users = await loadPublicUsers(db, rows.map((r) => r.target_id));
    return rows
      .filter((r) => users.has(r.target_id))
      .map((r) => ({ user: users.get(r.target_id)!, type: r.type, since: new Date(r.created_at).toISOString() }));
  });

  app.post('/users/@me/relationships', { config: { rateLimit: { max: app.config.rateLimit.friendRequestsPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = authOf(req).user.id;
    const { username } = parseBody(friendRequestSchema, req.body);
    const target = await findUserByTag(db, username);
    if (!target) throw new AppError(404, ErrorCode.UNKNOWN_ACCOUNT, 'Não encontramos ninguém com esse identificador.');
    if (target.id === me) throw new AppError(400, ErrorCode.VALIDATION, 'Você não pode adicionar a si mesmo.');

    const mine = await relationship(db, me, target.id);
    if (mine?.type === 'friend') throw new AppError(400, ErrorCode.VALIDATION, 'Vocês já são amigos.');
    if (mine?.type === 'outgoing') return reply.status(200).send(mine);
    if (mine?.type === 'blocked') throw new AppError(400, ErrorCode.VALIDATION, 'Desbloqueie essa pessoa antes de adicioná-la.');

    // Pedido cruzado: a outra pessoa já tinha pedido — vira amizade direto.
    if (mine?.type === 'incoming') {
      await makeFriends(db, me, target.id);
      await notifyRelationship(me, target.id);
      sharePresence(me, target.id);
      return reply.status(200).send(await relationship(db, me, target.id));
    }

    if (await isBlockedEitherWay(db, me, target.id)) throw cannotRequest();
    const settings = await getUserSettings(db, target.id);
    if (settings.friendRequestsFrom === 'nobody') throw cannotRequest();
    if (settings.friendRequestsFrom === 'server_members' && !(await shareServer(db, me, target.id))) throw cannotRequest();

    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'outgoing') ON CONFLICT DO NOTHING`, [me, target.id]);
      await tx.query(`INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'incoming') ON CONFLICT DO NOTHING`, [target.id, me]);
    });
    await notifyRelationship(me, target.id);
    return reply.status(201).send(await relationship(db, me, target.id));
  });

  /** Aceitar um pedido recebido. */
  app.put('/users/@me/relationships/:userId', async (req) => {
    const me = authOf(req).user.id;
    const { userId } = parseBody(userIdParams, req.params);
    const rel = await relationship(db, me, userId);
    if (rel?.type !== 'incoming') throw notFound('Pedido de amizade não encontrado.');
    await makeFriends(db, me, userId);
    await notifyRelationship(me, userId);
    sharePresence(me, userId);
    return relationship(db, me, userId);
  });

  /** Remove amizade, cancela/recusa pedido ou desbloqueia — tudo que exista nessa relação. */
  app.delete('/users/@me/relationships/:userId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { userId } = parseBody(userIdParams, req.params);
    const rel = await relationship(db, me, userId);
    if (!rel) throw notFound('Relação não encontrada.');
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM relationships WHERE user_id = $1 AND target_id = $2', [me, userId]);
      // O bloqueio é unilateral: desbloquear não mexe na linha da outra pessoa.
      if (rel.type !== 'blocked') {
        await tx.query(`DELETE FROM relationships WHERE user_id = $1 AND target_id = $2 AND type <> 'blocked'`, [userId, me]);
      }
    });
    await notifyRelationship(me, userId);
    return reply.status(204).send();
  });

  app.put('/users/@me/relationships/:userId/block', async (req) => {
    const me = authOf(req).user.id;
    const { userId } = parseBody(userIdParams, req.params);
    if (userId === me) throw new AppError(400, ErrorCode.VALIDATION, 'Você não pode bloquear a si mesmo.');
    if ((await loadPublicUsers(db, [userId])).size === 0) throw notFound('Usuário não encontrado.');
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'blocked')
         ON CONFLICT (user_id, target_id) DO UPDATE SET type = 'blocked', created_at = now()`,
        [me, userId],
      );
      await tx.query(`DELETE FROM relationships WHERE user_id = $1 AND target_id = $2 AND type <> 'blocked'`, [userId, me]);
    });
    await notifyRelationship(me, userId);
    // Quem foi bloqueado deixa de ver a presença de quem bloqueou.
    dispatcher.toUsers([userId], { type: 'PRESENCE_UPDATE', userId: me, status: 'offline' });
    return relationship(db, me, userId);
  });

  app.get('/users/:userId', async (req) => {
    const me = authOf(req).user.id;
    const { userId } = parseBody(userIdParams, req.params);
    const { rows } = await db.query<PublicUserRow>(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
    if (!rows[0]) throw notFound('Usuário não encontrado.');
    const { rows: mutual } = await db.query<{ id: string; name: string }>(
      `SELECT s.id, s.name FROM servers s
         JOIN server_members a ON a.server_id = s.id AND a.user_id = $1
         JOIN server_members b ON b.server_id = s.id AND b.user_id = $2
        ORDER BY s.name`,
      [me, userId],
    );
    const rel = await relationship(db, me, userId);
    return { user: toPublicUser(rows[0]), relationship: rel?.type ?? null, mutualServers: mutual };
  });

  app.get('/users/@me/presences', async (req) => {
    const me = authOf(req).user.id;
    const audience = await dispatcher.presenceAudience(me);
    return Object.fromEntries(audience.map((id) => [id, hub.presenceOf(id)]));
  });

  app.get('/users/@me/channels', async (req): Promise<DmChannel[]> => {
    const me = authOf(req).user.id;
    const { rows } = await db.query<{ id: string; last_message_id: string | null; other: string }>(
      `SELECT c.id, c.last_message_id, o.user_id AS other
         FROM channels c
         JOIN dm_recipients m ON m.channel_id = c.id AND m.user_id = $1
         JOIN dm_recipients o ON o.channel_id = c.id AND o.user_id <> $1
        WHERE c.type = 'dm'
        ORDER BY c.last_message_id DESC NULLS LAST`,
      [me],
    );
    const users = await loadPublicUsers(db, rows.map((r) => r.other));
    return rows
      .filter((r) => users.has(r.other))
      .map((r) => ({ id: r.id, type: 'dm', recipient: users.get(r.other)!, lastMessageId: r.last_message_id }));
  });

  app.post('/users/@me/channels', async (req): Promise<DmChannel> => {
    const me = authOf(req).user.id;
    const { recipientId } = parseBody(openDmSchema, req.body);
    if (recipientId === me) throw new AppError(400, ErrorCode.VALIDATION, 'Você não pode conversar consigo mesmo.');
    const users = await loadPublicUsers(db, [recipientId]);
    const recipient = users.get(recipientId);
    if (!recipient) throw notFound('Usuário não encontrado.');

    const existing = await findDm(db, me, recipientId);
    if (existing) return { id: existing.id, type: 'dm', recipient, lastMessageId: existing.last_message_id };

    await assertCanDm(db, me, recipientId);
    const id = uuidv7();
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO channels (id, type) VALUES ($1, 'dm')`, [id]);
      await tx.query('INSERT INTO dm_recipients (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [id, me, recipientId]);
    });
    return { id, type: 'dm', recipient, lastMessageId: null };
  });
}

async function makeFriends(q: Queryable, a: string, b: string) {
  await q.query(
    `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'friend'), ($2, $1, 'friend')
     ON CONFLICT (user_id, target_id) DO UPDATE SET type = 'friend', created_at = now()`,
    [a, b],
  );
}

async function findDm(q: Queryable, a: string, b: string) {
  const { rows } = await q.query<{ id: string; last_message_id: string | null }>(
    `SELECT c.id, c.last_message_id FROM channels c
       JOIN dm_recipients x ON x.channel_id = c.id AND x.user_id = $1
       JOIN dm_recipients y ON y.channel_id = c.id AND y.user_id = $2
      WHERE c.type = 'dm' LIMIT 1`,
    [a, b],
  );
  return rows[0];
}

/**
 * Regras de mensagem direta: nunca com bloqueio em qualquer direção; permitido entre amigos;
 * entre membros de um servidor em comum, se o destinatário permitir.
 */
export async function assertCanDm(q: Queryable, from: string, to: string): Promise<void> {
  const denied = () => forbidden('Essa pessoa não está recebendo mensagens diretas de você.');
  if (await isBlockedEitherWay(q, from, to)) throw denied();
  const { rows } = await q.query(`SELECT 1 FROM relationships WHERE user_id = $1 AND target_id = $2 AND type = 'friend'`, [from, to]);
  if (rows.length > 0) return;
  const settings = await getUserSettings(q, to);
  if (settings.allowDmsFromServerMembers && (await shareServer(q, from, to))) return;
  throw denied();
}
