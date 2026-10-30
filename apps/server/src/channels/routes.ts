import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ErrorCode,
  Permission,
  canGrant,
  createChannelSchema,
  editMessageSchema,
  emojiSchema,
  extractMentions,
  hasPermission,
  messageQuerySchema,
  overwriteSchema,
  parsePermissions,
  reportSchema,
  searchQuerySchema,
  sendMessageSchema,
  updateChannelSchema,
  type Message,
  type ReadState,
} from '@nexo/protocol';
import { authOf, requireAuth } from '../auth/guard';
import { AppError, forbidden, notFound, parseBody } from '../http/errors';
import { uuidv7 } from '../lib/ids';
import { hydrateMessages, loadReactions, type MessageRow } from '../messages/serialize';
import {
  channelAccess,
  loadOverwrites,
  memberContext,
  memberTop,
  requirePerm,
  type ChannelAccess,
  type ChannelRow,
} from '../permissions/service';
import { audit } from '../servers/routes';
import { toChannel } from '../servers/serialize';
import { assertCanDm } from '../social/routes';

const serverParams = z.object({ serverId: z.string().uuid() });
const channelParams = z.object({ channelId: z.string().uuid() });
const messageParams = channelParams.extend({ messageId: z.string().uuid() });
const overwriteParams = channelParams.extend({ targetId: z.string().uuid() });
const reactionParams = messageParams.extend({ emoji: z.string().max(64) });
const ackSchema = z.object({ messageId: z.string().uuid() });
const mentionsQuery = z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(25) });

const TEXT_TYPES = new Set(['text', 'announcement', 'dm']);
const MAX_REACTION_KINDS = 20;

/** Canais de texto usam nomes no estilo "assim-mesmo": minúsculas e hífens. */
export function normalizeChannelName(name: string, type: string): string {
  if (type !== 'text' && type !== 'announcement') return name.trim();
  const n = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-');
  return n || 'canal';
}

/** Limite simples por usuário: no máximo N mensagens por janela. Em memória (um processo). */
class SlidingLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  check(key: string): number {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.ceil((this.windowMs - (now - list[0]!)) / 1000);
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }
}

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  const { db, dispatcher } = app;
  const messageLimiter = new SlidingLimiter(5, 5000);
  app.addHook('preHandler', requireAuth);

  const textOnly = (a: ChannelAccess) => {
    if (!TEXT_TYPES.has(a.channel.type)) throw new AppError(400, ErrorCode.VALIDATION, 'Este canal não aceita mensagens de texto.');
  };

  async function channelDto(channelId: string, userId: string) {
    const a = await channelAccess(db, channelId, userId);
    return toChannel(a.channel, await loadOverwrites(db, [channelId]), a.perms);
  }

  /* ---------------- canais ---------------- */

  app.post('/servers/:serverId/channels', async (req, reply) => {
    const me = authOf(req).user.id;
    const { serverId } = parseBody(serverParams, req.params);
    const input = parseBody(createChannelSchema, req.body);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.MANAGE_CHANNELS);

    let parentId: string | null = input.parentId ?? null;
    if (input.type === 'category') parentId = null;
    if (parentId) {
      const { rows } = await db.query<ChannelRow>('SELECT * FROM channels WHERE id = $1 AND server_id = $2', [parentId, serverId]);
      if (rows[0]?.type !== 'category') throw new AppError(400, ErrorCode.VALIDATION, 'Categoria inválida.');
    }
    const { rows: count } = await db.query<{ n: number; pos: number | null }>(
      'SELECT count(*)::int AS n, max(position) AS pos FROM channels WHERE server_id = $1 AND parent_id IS NOT DISTINCT FROM $2',
      [serverId, parentId],
    );
    const { rows: total } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM channels WHERE server_id = $1', [serverId]);
    if ((total[0]?.n ?? 0) >= 500) throw new AppError(400, ErrorCode.VALIDATION, 'Limite de canais atingido.');

    const id = uuidv7();
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO channels (id, server_id, type, name, topic, parent_id, position) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        id,
        serverId,
        input.type,
        normalizeChannelName(input.name, input.type),
        input.topic ?? '',
        parentId,
        (count[0]?.pos ?? -1) + 1,
      ]);
      if (input.private) {
        // Privado: @everyone não vê; quem criou continua vendo.
        await tx.query("INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1, 'role', $2, 0, $3)", [
          id,
          ctx.everyone.id,
          Permission.VIEW_CHANNEL.toString(),
        ]);
        const keep = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CONNECT_VOICE | Permission.SPEAK;
        await tx.query("INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1, 'member', $2, $3, 0)", [
          id,
          me,
          (keep & ctx.basePerms).toString(),
        ]);
      }
      await audit(tx, serverId, me, 'channel.create', id, { name: input.name, type: input.type, private: !!input.private });
    });
    await dispatcher.serverSync(serverId);
    return reply.status(201).send(await channelDto(id, me));
  });

  app.patch('/channels/:channelId', async (req) => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const input = parseBody(updateChannelSchema, req.body);
    const a = await channelAccess(db, channelId, me);
    if (!a.ctx) throw forbidden();
    requirePerm(a.perms, Permission.MANAGE_CHANNELS);
    if (input.parentId) {
      const { rows } = await db.query<ChannelRow>('SELECT * FROM channels WHERE id = $1 AND server_id = $2', [input.parentId, a.channel.server_id]);
      if (rows[0]?.type !== 'category' || a.channel.type === 'category') throw new AppError(400, ErrorCode.VALIDATION, 'Categoria inválida.');
    }
    await db.query(
      `UPDATE channels SET name = COALESCE($2, name), topic = COALESCE($3, topic),
              parent_id = CASE WHEN $4::boolean THEN $5::uuid ELSE parent_id END,
              position = COALESCE($6, position)
        WHERE id = $1`,
      [
        channelId,
        input.name !== undefined ? normalizeChannelName(input.name, a.channel.type) : null,
        input.topic ?? null,
        input.parentId !== undefined,
        input.parentId ?? null,
        input.position ?? null,
      ],
    );
    await audit(db, a.channel.server_id!, me, 'channel.update', channelId, input);
    await dispatcher.serverSync(a.channel.server_id!);
    return channelDto(channelId, me);
  });

  app.delete('/channels/:channelId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const a = await channelAccess(db, channelId, me);
    if (!a.ctx) throw forbidden('Conversas privadas não podem ser excluídas.');
    requirePerm(a.perms, Permission.MANAGE_CHANNELS);
    await db.query('DELETE FROM channels WHERE id = $1', [channelId]);
    await audit(db, a.channel.server_id!, me, 'channel.delete', channelId, { name: a.channel.name });
    await dispatcher.serverSync(a.channel.server_id!);
    return reply.status(204).send();
  });

  /* ---------------- overwrites ---------------- */

  app.put('/channels/:channelId/overwrites/:targetId', async (req) => {
    const me = authOf(req).user.id;
    const { channelId, targetId } = parseBody(overwriteParams, req.params);
    const input = parseBody(overwriteSchema, req.body);
    const a = await channelAccess(db, channelId, me);
    if (!a.ctx) throw forbidden();
    requirePerm(a.perms, Permission.MANAGE_ROLES);
    const allow = parsePermissions(input.allow);
    const deny = parsePermissions(input.deny);
    // Tanto liberar quanto negar exigem possuir a permissão — e ADMINISTRATOR nunca vale por canal.
    if (!canGrant(a.perms, allow | deny)) throw forbidden('Você só pode ajustar permissões que você mesmo tem neste canal.');
    if ((allow | deny) & Permission.ADMINISTRATOR) throw new AppError(400, ErrorCode.VALIDATION, 'Administrador não é uma permissão de canal.');

    if (input.targetType === 'role') {
      const role = a.ctx.roles.find((r) => r.id === targetId);
      if (!role) throw notFound('Cargo não encontrado.');
      if (!a.ctx.isOwner && !role.is_default && role.position >= a.ctx.top) throw forbidden('Você só pode ajustar cargos abaixo do seu.');
    } else {
      const { rows } = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [a.channel.server_id, targetId]);
      if (rows.length === 0) throw notFound('Membro não encontrado.');
      if (targetId !== me && (await memberTop(db, a.ctx.server, targetId)) >= a.ctx.top) throw forbidden('Você só pode ajustar membros abaixo de você.');
    }
    await db.query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, target_type = EXCLUDED.target_type`,
      [channelId, input.targetType, targetId, allow.toString(), deny.toString()],
    );
    await audit(db, a.channel.server_id!, me, 'overwrite.update', channelId, { targetId, ...input });
    await dispatcher.serverSync(a.channel.server_id!);
    return channelDto(channelId, me).catch(() => null);
  });

  app.delete('/channels/:channelId/overwrites/:targetId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { channelId, targetId } = parseBody(overwriteParams, req.params);
    const a = await channelAccess(db, channelId, me);
    if (!a.ctx) throw forbidden();
    requirePerm(a.perms, Permission.MANAGE_ROLES);
    const { rows } = await db.query<{ allow: string; deny: string }>(
      'SELECT allow::text AS allow, deny::text AS deny FROM channel_overwrites WHERE channel_id = $1 AND target_id = $2',
      [channelId, targetId],
    );
    if (!rows[0]) throw notFound('Ajuste de permissão não encontrado.');
    if (!canGrant(a.perms, parsePermissions(rows[0].allow) | parsePermissions(rows[0].deny))) {
      throw forbidden('Você só pode remover ajustes de permissões que você mesmo tem.');
    }
    await db.query('DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_id = $2', [channelId, targetId]);
    await audit(db, a.channel.server_id!, me, 'overwrite.delete', channelId, { targetId });
    await dispatcher.serverSync(a.channel.server_id!);
    return reply.status(204).send();
  });

  /* ---------------- mensagens ---------------- */

  app.get('/channels/:channelId/messages', async (req): Promise<Message[]> => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const query = parseBody(messageQuerySchema, req.query);
    const a = await channelAccess(db, channelId, me);
    textOnly(a);
    let rows: MessageRow[];
    if (query.after) {
      ({ rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [
        channelId,
        query.after,
        query.limit,
      ]));
      rows.reverse();
    } else {
      ({ rows } = await db.query<MessageRow>(
        'SELECT * FROM messages WHERE channel_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3',
        [channelId, query.before ?? null, query.limit],
      ));
    }
    // Ordem cronológica (mais antiga primeiro) para o cliente.
    return (await hydrateMessages(db, rows, me)).reverse();
  });

  app.get('/channels/:channelId/messages/search', async (req): Promise<Message[]> => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const { q, limit } = parseBody(searchQuerySchema, req.query);
    const a = await channelAccess(db, channelId, me);
    textOnly(a);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await db.query<MessageRow>(
      `SELECT * FROM messages WHERE channel_id = $1 AND content ILIKE $2 ESCAPE '\\' ORDER BY id DESC LIMIT $3`,
      [channelId, pattern, limit],
    );
    return hydrateMessages(db, rows, me);
  });

  app.post('/channels/:channelId/messages', async (req, reply): Promise<Message> => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const input = parseBody(sendMessageSchema, req.body);
    const a = await channelAccess(db, channelId, me);
    textOnly(a);
    requirePerm(a.perms, Permission.SEND_MESSAGES, 'Você não pode enviar mensagens neste canal.');
    if (a.channel.type === 'announcement') requirePerm(a.perms, Permission.MANAGE_MESSAGES, 'Só moderadores publicam em canais de anúncios.');
    if (a.dmRecipients) await assertCanDm(db, me, a.dmRecipients.find((u) => u !== me)!);

    // Reenvio com o mesmo nonce (ex.: após queda de rede) devolve a mensagem já criada.
    if (input.nonce) {
      const { rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE author_id = $1 AND nonce = $2', [me, input.nonce]);
      if (rows[0]) return (await hydrateMessages(db, rows, me))[0]!;
    }

    const wait = messageLimiter.check(me);
    if (wait) throw new AppError(429, ErrorCode.RATE_LIMITED, 'Você está enviando mensagens rápido demais.', { retryAfter: wait });

    if (input.replyToId) {
      const { rows } = await db.query('SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2', [input.replyToId, channelId]);
      if (rows.length === 0) throw new AppError(400, ErrorCode.VALIDATION, 'A mensagem respondida não está neste canal.');
    }

    const id = uuidv7();
    const mentions = extractMentions(input.content);
    let row: MessageRow;
    try {
      row = await db.transaction(async (tx) => {
        const { rows } = await tx.query<MessageRow>(
          `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, mentions, nonce)
           VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7) RETURNING *`,
          [id, channelId, me, input.content, input.replyToId ?? null, mentions, input.nonce ?? null],
        );
        // Anexos: só os pendentes da própria pessoa, enviados para ESTE canal. Qualquer id que não se
        // encaixe (de outra pessoa, de outro canal, já usado) invalida o envio inteiro.
        const attachmentIds = [...new Set(input.attachmentIds ?? [])];
        if (attachmentIds.length) {
          const { rows: linked } = await tx.query<{ id: string }>(
            `UPDATE files SET message_id = $1
              WHERE id = ANY($2::uuid[]) AND owner_id = $3 AND channel_id = $4 AND kind = 'attachment' AND message_id IS NULL
              RETURNING id`,
            [id, attachmentIds, me, channelId],
          );
          if (linked.length !== attachmentIds.length) throw new AppError(400, ErrorCode.VALIDATION, 'Um dos anexos não está disponível. Envie-o de novo.');
        }
        await tx.query('UPDATE channels SET last_message_id = $2 WHERE id = $1', [channelId, id]);
        // Quem envia leu até a própria mensagem.
        await tx.query(
          `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id`,
          [me, channelId, id],
        );
        return rows[0]!;
      });
    } catch (err) {
      // Duas tentativas simultâneas com o mesmo nonce: a segunda devolve a primeira.
      if ((err as { code?: string }).code === '23505' && input.nonce) {
        const { rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE author_id = $1 AND nonce = $2', [me, input.nonce]);
        if (rows[0]) return (await hydrateMessages(db, rows, me))[0]!;
      }
      throw err;
    }
    const [message] = await hydrateMessages(db, [row], me);
    // "me" das reações é por destinatário; mensagem nova não tem reações, então o mesmo objeto serve a todos.
    await dispatcher.toChannel(a.channel, { type: 'MESSAGE_CREATE', message: message! });
    return reply.status(201).send(message!);
  });

  app.patch('/channels/:channelId/messages/:messageId', async (req): Promise<Message> => {
    const me = authOf(req).user.id;
    const { channelId, messageId } = parseBody(messageParams, req.params);
    const { content } = parseBody(editMessageSchema, req.body);
    const a = await channelAccess(db, channelId, me);
    const { rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
    if (!rows[0]) throw notFound('Mensagem não encontrada.');
    if (rows[0].author_id !== me) throw forbidden('Você só pode editar suas próprias mensagens.');
    const { rows: updated } = await db.query<MessageRow>(
      'UPDATE messages SET content = $2, mentions = $3::uuid[], edited_at = now() WHERE id = $1 RETURNING *',
      [messageId, content, extractMentions(content)],
    );
    const [message] = await hydrateMessages(db, updated, me);
    // O cliente aplica só conteúdo/edição/menções; reações chegam por REACTIONS_UPDATE.
    await dispatcher.toChannel(a.channel, { type: 'MESSAGE_UPDATE', message: message! });
    return message!;
  });

  app.delete('/channels/:channelId/messages/:messageId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { channelId, messageId } = parseBody(messageParams, req.params);
    const a = await channelAccess(db, channelId, me);
    const { rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
    if (!rows[0]) throw notFound('Mensagem não encontrada.');
    const own = rows[0].author_id === me;
    if (!own) {
      // Em conversas privadas ninguém apaga mensagem alheia.
      if (!a.ctx) throw forbidden('Você só pode excluir suas próprias mensagens.');
      requirePerm(a.perms, Permission.MANAGE_MESSAGES, 'Você não pode excluir mensagens de outras pessoas.');
    }
    const { rows: attached } = await db.query<{ id: string }>('SELECT id FROM files WHERE message_id = $1', [messageId]);
    await db.transaction(async (tx) => {
      // Os registros dos anexos saem junto (ON DELETE CASCADE); o conteúdo é apagado logo depois.
      await tx.query('DELETE FROM messages WHERE id = $1', [messageId]);
      await tx.query(
        // Postgres não tem max() para uuid; ORDER BY usa o índice (channel_id, id DESC).
        `UPDATE channels SET last_message_id = (SELECT id FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1)
          WHERE id = $1 AND last_message_id = $2`,
        [channelId, messageId],
      );
      if (!own && a.ctx) await audit(tx, a.channel.server_id!, me, 'message.delete', rows[0]!.author_id, { channelId });
    });
    await app.files.remove(attached.map((f) => f.id));
    await dispatcher.toChannel(a.channel, { type: 'MESSAGE_DELETE', channelId, messageId });
    return reply.status(204).send();
  });

  /* ---------------- reações ---------------- */

  async function publishReactions(a: ChannelAccess, messageId: string) {
    const rx = await loadReactions(db, [messageId]);
    await dispatcher.toChannel(a.channel, {
      type: 'REACTIONS_UPDATE',
      channelId: a.channel.id,
      messageId,
      reactions: rx.map((r) => ({ emoji: r.emoji, count: r.user_ids.length, userIds: r.user_ids })),
    });
  }

  app.put('/channels/:channelId/messages/:messageId/reactions/:emoji', async (req, reply) => {
    const me = authOf(req).user.id;
    const params = parseBody(reactionParams, req.params);
    const emoji = parseBody(emojiSchema, decodeURIComponent(params.emoji));
    const a = await channelAccess(db, params.channelId, me);
    textOnly(a);
    const { rows } = await db.query('SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2', [params.messageId, params.channelId]);
    if (rows.length === 0) throw notFound('Mensagem não encontrada.');
    const { rows: kinds } = await db.query<{ emoji: string }>('SELECT DISTINCT emoji FROM reactions WHERE message_id = $1', [params.messageId]);
    const isNew = !kinds.some((k) => k.emoji === emoji);
    // Reagir com um emoji que já está na mensagem não exige permissão; adicionar um novo, sim.
    if (isNew) {
      requirePerm(a.perms, Permission.ADD_REACTIONS, 'Você não pode adicionar reações neste canal.');
      if (kinds.length >= MAX_REACTION_KINDS) throw new AppError(400, ErrorCode.VALIDATION, 'Limite de reações nesta mensagem.');
    }
    await db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [params.messageId, me, emoji]);
    await publishReactions(a, params.messageId);
    return reply.status(204).send();
  });

  app.delete('/channels/:channelId/messages/:messageId/reactions/:emoji', async (req, reply) => {
    const me = authOf(req).user.id;
    const params = parseBody(reactionParams, req.params);
    const emoji = decodeURIComponent(params.emoji);
    const a = await channelAccess(db, params.channelId, me);
    await db.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [params.messageId, me, emoji]);
    await publishReactions(a, params.messageId);
    return reply.status(204).send();
  });

  /* ---------------- leitura ---------------- */

  app.post('/channels/:channelId/ack', async (req, reply) => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const { messageId } = parseBody(ackSchema, req.body);
    await channelAccess(db, channelId, me);
    // GREATEST evita que um ack atrasado "desleia" mensagens mais novas.
    await db.query(
      `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id)`,
      [me, channelId, messageId],
    );
    return reply.status(204).send();
  });

  /**
   * Caixa de menções: mensagens recentes que mencionam a pessoa, só de canais que ela pode ver AGORA
   * (perder acesso a um canal tira as menções dele daqui). Paginada por `before`.
   */
  app.get('/users/@me/mentions', async (req): Promise<Message[]> => {
    const me = authOf(req).user.id;
    const { before, limit } = parseBody(mentionsQuery, req.query);
    // Candidatas: canais de servidores em que a pessoa está e DMs dela. A checagem fina vem depois.
    const { rows } = await db.query<MessageRow>(
      `SELECT m.* FROM messages m
         JOIN channels c ON c.id = m.channel_id
        WHERE $1::uuid = ANY(m.mentions)
          AND m.author_id <> $1
          AND ($2::uuid IS NULL OR m.id < $2)
          AND (
            c.server_id IN (SELECT server_id FROM server_members WHERE user_id = $1)
            OR c.id IN (SELECT channel_id FROM dm_recipients WHERE user_id = $1)
          )
        ORDER BY m.id DESC
        LIMIT $3`,
      [me, before ?? null, limit * 2],
    );
    const allowed = new Map<string, boolean>();
    const visible: MessageRow[] = [];
    for (const r of rows) {
      if (!allowed.has(r.channel_id)) {
        allowed.set(
          r.channel_id,
          await channelAccess(db, r.channel_id, me).then(
            () => true,
            () => false,
          ),
        );
      }
      if (allowed.get(r.channel_id)) visible.push(r);
      if (visible.length >= limit) break;
    }
    return hydrateMessages(db, visible, me);
  });

  app.get('/users/@me/read-states', async (req): Promise<ReadState[]> => {
    const { rows } = await db.query<{ channel_id: string; last_read_id: string | null }>(
      'SELECT channel_id, last_read_id FROM read_states WHERE user_id = $1',
      [authOf(req).user.id],
    );
    return rows.map((r) => ({ channelId: r.channel_id, lastReadId: r.last_read_id }));
  });

  /* ---------------- denúncias ---------------- */

  app.post('/reports', { config: { rateLimit: { max: app.config.rateLimit.reportsPerHour, timeWindow: '1 hour' } } }, async (req, reply) => {
    const me = authOf(req).user.id;
    const input = parseBody(reportSchema, req.body);
    let snapshot = '';
    let targetUser = input.userId ?? null;
    if (input.messageId) {
      const { rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [input.messageId]);
      if (!rows[0]) throw notFound('Mensagem não encontrada.');
      // Só denuncia o que consegue ver.
      await channelAccess(db, rows[0].channel_id, me);
      snapshot = rows[0].content;
      targetUser = rows[0].author_id;
    }
    await db.query('INSERT INTO reports (id, reporter_id, target_user_id, message_id, reason, details, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      randomUUID(),
      me,
      targetUser,
      input.messageId ?? null,
      input.reason,
      input.details ?? '',
      snapshot,
    ]);
    return reply.status(201).send({ ok: true });
  });
}

/** Usado pelo gateway: o usuário pode digitar neste canal? */
export async function canType(app: FastifyInstance, channelId: string, userId: string): Promise<ChannelAccess | null> {
  try {
    const a = await channelAccess(app.db, channelId, userId);
    if (!TEXT_TYPES.has(a.channel.type) || !hasPermission(a.perms, Permission.SEND_MESSAGES)) return null;
    return a;
  } catch {
    return null;
  }
}
