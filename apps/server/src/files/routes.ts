import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ErrorCode, Permission, type Attachment } from '@nexo/protocol';
import { authOf, requireAuth } from '../auth/guard';
import { AppError, notFound, parseBody } from '../http/errors';
import { channelAccess, requirePerm } from '../permissions/service';
import { assertCanDm } from '../social/routes';
import { findUserById, toSelfUser } from '../users/repo';
import { toAttachment, type FileRow } from './service';

const idParams = z.object({ id: z.string().uuid() });
const channelParams = z.object({ channelId: z.string().uuid() });
const nameQuery = z.object({ filename: z.string().min(1).max(255).default('arquivo') });

const TEXT_TYPES = new Set(['text', 'announcement', 'dm']);
/** Quantos anexos ainda não usados uma pessoa pode acumular (evita encher o disco). */
const MAX_PENDING_PER_USER = 30;

/** RFC 6266: nome original preservado (UTF-8) e um nome ASCII de reserva. */
function contentDisposition(kind: 'inline' | 'attachment', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const { db, files, config, dispatcher } = app;
  app.addHook('preHandler', requireAuth);

  // Upload = corpo binário puro (sem multipart): menos código para analisar, limite de tamanho do Fastify.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.files.maxAttachmentBytes }, (_req, body, done) =>
    done(null, body),
  );

  const recent = new Map<string, number[]>();
  const throttle = (userId: string) => {
    const now = Date.now();
    const list = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= config.files.uploadsPerMinute) {
      throw new AppError(429, ErrorCode.RATE_LIMITED, 'Muitos envios em pouco tempo. Aguarde um pouco.', { retryAfter: 30 });
    }
    list.push(now);
    recent.set(userId, list);
  };
  const bodyOf = (b: unknown): Buffer => {
    if (!Buffer.isBuffer(b)) throw new AppError(400, ErrorCode.VALIDATION, 'Envie o arquivo como application/octet-stream.');
    return b;
  };

  /**
   * Envia um anexo para usar numa mensagem deste canal. Exige poder enviar mensagens e anexar
   * arquivos aqui. O anexo fica "pendente" (visível só para quem enviou) até entrar numa mensagem.
   */
  app.post('/channels/:channelId/attachments', { bodyLimit: config.files.maxAttachmentBytes }, async (req, reply): Promise<Attachment> => {
    const me = authOf(req).user.id;
    const { channelId } = parseBody(channelParams, req.params);
    const { filename } = parseBody(nameQuery, req.query);
    const a = await channelAccess(db, channelId, me);
    if (!TEXT_TYPES.has(a.channel.type)) throw new AppError(400, ErrorCode.VALIDATION, 'Este canal não aceita mensagens.');
    requirePerm(a.perms, Permission.SEND_MESSAGES, 'Você não pode enviar mensagens neste canal.');
    requirePerm(a.perms, Permission.ATTACH_FILES, 'Você não pode enviar arquivos neste canal.');
    if (a.dmRecipients) await assertCanDm(db, me, a.dmRecipients.find((u) => u !== me)!);
    throttle(me);
    const { rows: pend } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM files WHERE owner_id = $1 AND kind = 'attachment' AND message_id IS NULL`,
      [me],
    );
    if ((pend[0]?.n ?? 0) >= MAX_PENDING_PER_USER) {
      throw new AppError(429, ErrorCode.RATE_LIMITED, 'Você tem anexos demais esperando envio. Envie ou remova alguns.');
    }
    const row = await files.save(db, {
      owner: me,
      kind: 'attachment',
      channelId,
      filename,
      data: bodyOf(req.body),
      imageOnly: false,
      max: config.files.maxAttachmentBytes,
    });
    return reply.status(201).send(toAttachment(row));
  });

  /** Remove um anexo ainda não enviado (só quem enviou). */
  app.delete('/attachments/:id', async (req, reply) => {
    const me = authOf(req).user.id;
    const { id } = parseBody(idParams, req.params);
    const { rows } = await db.query<{ id: string }>(
      `DELETE FROM files WHERE id = $1 AND owner_id = $2 AND kind = 'attachment' AND message_id IS NULL RETURNING id`,
      [id, me],
    );
    if (!rows[0]) throw notFound('Anexo não encontrado.');
    await files.remove([id]);
    return reply.status(204).send();
  });

  /**
   * Conteúdo de um arquivo. Conhecer o id NÃO basta:
   *  - anexo: precisa estar numa mensagem de um canal que a pessoa pode ver agora (ou ser dela, pendente);
   *  - avatar/banner: só os atuais de alguma conta (os antigos deixam de ser servidos).
   * Responde 404 em todos os casos negados, sem revelar se o arquivo existe.
   */
  app.get('/files/:id', async (req, reply: FastifyReply) => {
    const me = authOf(req).user.id;
    const { id } = parseBody(idParams, req.params);
    const { rows } = await db.query<FileRow>('SELECT * FROM files WHERE id = $1', [id]);
    const f = rows[0];
    if (!f) throw notFound('Arquivo não encontrado.');
    if (f.kind === 'attachment') {
      if (!f.message_id) {
        if (f.owner_id !== me) throw notFound('Arquivo não encontrado.');
      } else {
        await channelAccess(db, f.channel_id!, me).catch(() => {
          throw notFound('Arquivo não encontrado.');
        });
      }
    } else {
      const col = f.kind === 'avatar' ? 'avatar_id' : 'banner_id';
      const { rows: current } = await db.query(`SELECT 1 FROM users WHERE ${col} = $1`, [id]);
      if (!current.length) throw notFound('Arquivo não encontrado.');
    }
    const data = await files.store.get(id);
    if (!data) throw notFound('Arquivo não encontrado.');
    const inline = f.content_type.startsWith('image/') || f.content_type.startsWith('audio/') || f.content_type.startsWith('video/');
    return reply
      .header('content-type', f.content_type)
      .header('content-length', String(data.length))
      .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', f.filename))
      // Conteúdo imutável por id e checado por pessoa: cache só no próprio aparelho, nunca em proxies.
      .header('cache-control', 'private, max-age=86400, immutable')
      // Mesmo que algo escape da detecção de tipo, o navegador não executa nada vindo daqui.
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(data);
  });

  /* ---------------- avatar e banner ---------------- */

  for (const kind of ['avatar', 'banner'] as const) {
    const col = kind === 'avatar' ? 'avatar_id' : 'banner_id';
    const label = kind === 'avatar' ? 'avatar' : 'banner';

    app.put(`/users/@me/${kind}`, { bodyLimit: config.files.maxImageBytes }, async (req) => {
      const me = authOf(req).user.id;
      throttle(me);
      const { filename } = parseBody(nameQuery, req.query);
      const old = await db.query<{ id: string | null }>(`SELECT ${col} AS id FROM users WHERE id = $1`, [me]);
      const row = await db.transaction(async (tx) => {
        const f = await files.save(tx, { owner: me, kind, channelId: null, filename, data: bodyOf(req.body), imageOnly: true, max: config.files.maxImageBytes });
        await tx.query(`UPDATE users SET ${col} = $2 WHERE id = $1`, [me, f.id]);
        if (old.rows[0]?.id) await tx.query('DELETE FROM files WHERE id = $1', [old.rows[0].id]);
        return f;
      });
      if (old.rows[0]?.id) await files.remove([old.rows[0].id]);
      const user = toSelfUser((await findUserById(db, me))!);
      dispatcher.toUsers([me], { type: 'USER_UPDATE', user });
      return { user, [kind]: toAttachment(row) };
    });

    app.delete(`/users/@me/${kind}`, async (req) => {
      const me = authOf(req).user.id;
      const { rows } = await db.query<{ id: string | null }>(`SELECT ${col} AS id FROM users WHERE id = $1`, [me]);
      const old = rows[0]?.id;
      if (!old) throw new AppError(400, ErrorCode.VALIDATION, `Você não tem ${label}.`);
      await db.query('DELETE FROM files WHERE id = $1 AND owner_id = $2', [old, me]);
      await files.remove([old]);
      const user = toSelfUser((await findUserById(db, me))!);
      dispatcher.toUsers([me], { type: 'USER_UPDATE', user });
      return { user };
    });
  }
}
