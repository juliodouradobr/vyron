import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  ErrorCode,
  Permission,
  canGrant,
  createInviteSchema,
  createRoleSchema,
  createServerSchema,
  memberRolesSchema,
  parsePermissions,
  updateRoleSchema,
  updateServerSchema,
  type AuditEntry,
  type Invite,
  type InvitePreview,
  type Member,
  type ServerSummary,
} from '@nexo/protocol';
import { authOf, requireAuth } from '../auth/guard';
import type { Queryable } from '../db';
import { AppError, forbidden, notFound, parseBody } from '../http/errors';
import { inviteCode, uuidv7 } from '../lib/ids';
import { memberContext, memberTop, requirePerm, serverMemberIds, type ServerRow } from '../permissions/service';
import { loadPublicUsers } from '../users/public';
import { serverDetail, toRole, toServerSummary } from './serialize';

const serverParams = z.object({ serverId: z.string().uuid() });
const roleParams = serverParams.extend({ roleId: z.string().uuid() });
const memberParams = serverParams.extend({ userId: z.string().uuid() });
const inviteParams = z.object({ code: z.string().regex(/^[A-Za-z0-9]{6,16}$/) });

export async function audit(q: Queryable, serverId: string, actorId: string, action: string, targetId: string | null, details: object = {}) {
  await q.query('INSERT INTO audit_log (id, server_id, actor_id, action, target_id, details) VALUES ($1, $2, $3, $4, $5, $6)', [
    uuidv7(),
    serverId,
    actorId,
    action,
    targetId,
    JSON.stringify(details),
  ]);
}

const hierarchyError = () => forbidden('Você só pode gerenciar cargos e membros abaixo do seu cargo mais alto.');

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  const { db, dispatcher } = app;
  app.addHook('preHandler', requireAuth);

  /* ---------------- servidores ---------------- */

  app.get('/users/@me/servers', async (req): Promise<ServerSummary[]> => {
    const { rows } = await db.query<ServerRow>(
      `SELECT s.* FROM servers s JOIN server_members m ON m.server_id = s.id WHERE m.user_id = $1 ORDER BY m.joined_at`,
      [authOf(req).user.id],
    );
    return rows.map(toServerSummary);
  });

  app.post('/servers', { config: { rateLimit: { max: app.config.rateLimit.serverCreatePerHour, timeWindow: '1 hour' } } }, async (req, reply) => {
    const me = authOf(req).user.id;
    const input = parseBody(createServerSchema, req.body);
    const { rows: count } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM server_members WHERE user_id = $1', [me]);
    if ((count[0]?.n ?? 0) >= 100) throw new AppError(400, ErrorCode.VALIDATION, 'Você atingiu o limite de 100 servidores.');

    const serverId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO servers (id, name, description, owner_id) VALUES ($1, $2, $3, $4)', [
        serverId,
        input.name,
        input.description ?? '',
        me,
      ]);
      await tx.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [serverId, me]);
      await tx.query(`INSERT INTO roles (id, server_id, name, permissions, position, is_default) VALUES ($1, $2, '@everyone', $3, 0, true)`, [
        randomUUID(),
        serverId,
        DEFAULT_EVERYONE_PERMISSIONS.toString(),
      ]);
      const textCat = uuidv7();
      const voiceCat = uuidv7();
      await tx.query(
        `INSERT INTO channels (id, server_id, type, name, parent_id, position) VALUES
           ($1, $3, 'category', 'Canais de texto', NULL, 0),
           ($4, $3, 'text', 'geral', $1, 0),
           ($2, $3, 'category', 'Canais de voz', NULL, 1),
           ($5, $3, 'voice', 'Geral', $2, 0)`,
        [textCat, voiceCat, serverId, uuidv7(), uuidv7()],
      );
      await audit(tx, serverId, me, 'server.create', serverId, { name: input.name });
    });
    return reply.status(201).send(await serverDetail(db, serverId, me));
  });

  app.get('/servers/:serverId', async (req) => {
    const { serverId } = parseBody(serverParams, req.params);
    return serverDetail(db, serverId, authOf(req).user.id);
  });

  app.patch('/servers/:serverId', async (req) => {
    const me = authOf(req).user.id;
    const { serverId } = parseBody(serverParams, req.params);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.MANAGE_SERVER);
    const input = parseBody(updateServerSchema, req.body);
    await db.query('UPDATE servers SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1', [
      serverId,
      input.name ?? null,
      input.description ?? null,
    ]);
    await audit(db, serverId, me, 'server.update', serverId, input);
    await dispatcher.serverSync(serverId);
    return serverDetail(db, serverId, me);
  });

  app.delete('/servers/:serverId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { serverId } = parseBody(serverParams, req.params);
    const ctx = await memberContext(db, serverId, me);
    if (!ctx.isOwner) throw forbidden('Só o proprietário pode excluir o servidor.');
    const members = await serverMemberIds(db, serverId);
    await db.query('DELETE FROM servers WHERE id = $1', [serverId]);
    dispatcher.toUsers(members, { type: 'SERVER_REMOVE', serverId });
    await dispatcher.notifyServerChanged(serverId);
    return reply.status(204).send();
  });

  app.delete('/users/@me/servers/:serverId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { serverId } = parseBody(serverParams, req.params);
    const ctx = await memberContext(db, serverId, me);
    if (ctx.isOwner) throw new AppError(400, ErrorCode.VALIDATION, 'O proprietário não pode sair. Exclua o servidor ou transfira a posse.');
    await db.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, me]);
    await audit(db, serverId, me, 'member.leave', me);
    dispatcher.toUsers([me], { type: 'SERVER_REMOVE', serverId });
    await dispatcher.membersChanged(serverId);
    return reply.status(204).send();
  });

  /* ---------------- membros ---------------- */

  app.get('/servers/:serverId/members', async (req): Promise<Member[]> => {
    const { serverId } = parseBody(serverParams, req.params);
    await memberContext(db, serverId, authOf(req).user.id);
    const { rows } = await db.query<{ user_id: string; nickname: string | null; joined_at: Date; role_ids: string[] | null }>(
      `SELECT m.user_id, m.nickname, m.joined_at, array_remove(array_agg(mr.role_id), NULL) AS role_ids
         FROM server_members m
         LEFT JOIN member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
        WHERE m.server_id = $1
        GROUP BY m.user_id, m.nickname, m.joined_at
        ORDER BY m.joined_at
        LIMIT 1000`,
      [serverId],
    );
    const users = await loadPublicUsers(db, rows.map((r) => r.user_id));
    return rows
      .filter((r) => users.has(r.user_id))
      .map((r) => ({
        user: users.get(r.user_id)!,
        nickname: r.nickname,
        roleIds: r.role_ids ?? [],
        joinedAt: new Date(r.joined_at).toISOString(),
      }));
  });

  app.put('/servers/:serverId/members/:userId/roles', async (req) => {
    const me = authOf(req).user.id;
    const { serverId, userId } = parseBody(memberParams, req.params);
    const { roleIds } = parseBody(memberRolesSchema, req.body);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.MANAGE_ROLES);
    const target = await memberContext(db, serverId, userId).catch(() => {
      throw notFound('Membro não encontrado.');
    });
    if (userId !== me && (await memberTop(db, ctx.server, userId)) >= ctx.top) throw hierarchyError();

    const wanted = new Set(roleIds);
    const before = new Set(target.memberRoleIds);
    const changed = ctx.roles.filter((r) => wanted.has(r.id) !== before.has(r.id));
    for (const id of wanted) if (!ctx.roles.some((r) => r.id === id)) throw notFound('Cargo não encontrado.');
    for (const r of changed) {
      if (r.is_default) throw new AppError(400, ErrorCode.VALIDATION, 'O cargo @everyone é automático.');
      if (r.position >= ctx.top) throw hierarchyError();
      // Conceder um cargo equivale a conceder as permissões dele.
      if (wanted.has(r.id) && !canGrant(ctx.basePerms, parsePermissions(r.permissions))) {
        throw forbidden('Você não pode conceder um cargo com permissões que você não tem.');
      }
    }
    await db.transaction(async (tx) => {
      for (const r of changed) {
        if (wanted.has(r.id)) await tx.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)', [serverId, userId, r.id]);
        else await tx.query('DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3', [serverId, userId, r.id]);
      }
      if (changed.length) await audit(tx, serverId, me, 'member.roles', userId, { roleIds: [...wanted] });
    });
    await dispatcher.serverSync(serverId);
    await dispatcher.membersChanged(serverId);
    return { roleIds: [...wanted] };
  });

  app.delete('/servers/:serverId/members/:userId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { serverId, userId } = parseBody(memberParams, req.params);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.KICK_MEMBERS);
    if (userId === me) throw new AppError(400, ErrorCode.VALIDATION, 'Use "sair do servidor" para sair.');
    if (userId === ctx.server.owner_id) throw hierarchyError();
    await memberContext(db, serverId, userId).catch(() => {
      throw notFound('Membro não encontrado.');
    });
    if ((await memberTop(db, ctx.server, userId)) >= ctx.top) throw hierarchyError();
    await db.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
    await audit(db, serverId, me, 'member.kick', userId);
    dispatcher.toUsers([userId], { type: 'SERVER_REMOVE', serverId });
    await dispatcher.membersChanged(serverId);
    return reply.status(204).send();
  });

  /* ---------------- cargos ---------------- */

  app.post('/servers/:serverId/roles', async (req, reply) => {
    const me = authOf(req).user.id;
    const { serverId } = parseBody(serverParams, req.params);
    const input = parseBody(createRoleSchema, req.body);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.MANAGE_ROLES);
    const perms = input.permissions ? parsePermissions(input.permissions) : 0n;
    if (!canGrant(ctx.basePerms, perms)) throw forbidden('Você não pode criar um cargo com permissões que você não tem.');
    if (ctx.roles.length >= 250) throw new AppError(400, ErrorCode.VALIDATION, 'Limite de cargos atingido.');

    // Novo cargo entra logo acima do @everyone; os demais sobem uma posição.
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('UPDATE roles SET position = position + 1 WHERE server_id = $1 AND NOT is_default', [serverId]);
      await tx.query('INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES ($1, $2, $3, $4, $5, 1)', [
        id,
        serverId,
        input.name,
        input.color ?? null,
        perms.toString(),
      ]);
      await audit(tx, serverId, me, 'role.create', id, { name: input.name });
    });
    await dispatcher.serverSync(serverId);
    const role = (await memberContext(db, serverId, me)).roles.find((r) => r.id === id)!;
    return reply.status(201).send(toRole(role));
  });

  app.patch('/servers/:serverId/roles/:roleId', async (req) => {
    const me = authOf(req).user.id;
    const { serverId, roleId } = parseBody(roleParams, req.params);
    const input = parseBody(updateRoleSchema, req.body);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.MANAGE_ROLES);
    const role = ctx.roles.find((r) => r.id === roleId);
    if (!role) throw notFound('Cargo não encontrado.');
    // Ninguém edita o próprio cargo mais alto ou acima dele (exceto o proprietário): impede autopromoção.
    if (!ctx.isOwner && role.position >= ctx.top) throw hierarchyError();

    if (input.permissions !== undefined) {
      const next = parsePermissions(input.permissions);
      const added = next & ~parsePermissions(role.permissions);
      if (!canGrant(ctx.basePerms, added)) throw forbidden('Você não pode conceder permissões que você não tem.');
    }
    if (input.position !== undefined) {
      if (role.is_default) throw new AppError(400, ErrorCode.VALIDATION, 'O @everyone fica sempre na base.');
      if (!ctx.isOwner && input.position >= ctx.top) throw hierarchyError();
    }
    if (role.is_default && input.name !== undefined) throw new AppError(400, ErrorCode.VALIDATION, 'O @everyone não pode ser renomeado.');

    await db.transaction(async (tx) => {
      if (input.position !== undefined && input.position !== role.position) {
        // Move o cargo e desloca os vizinhos, mantendo posições únicas e contíguas.
        const from = role.position;
        const to = input.position;
        if (to > from) {
          await tx.query('UPDATE roles SET position = position - 1 WHERE server_id = $1 AND position > $2 AND position <= $3 AND NOT is_default', [serverId, from, to]);
        } else {
          await tx.query('UPDATE roles SET position = position + 1 WHERE server_id = $1 AND position >= $3 AND position < $2 AND NOT is_default', [serverId, from, to]);
        }
      }
      await tx.query(
        `UPDATE roles SET name = COALESCE($3, name),
                          color = CASE WHEN $4::boolean THEN $5::integer ELSE color END,
                          permissions = COALESCE($6::bigint, permissions),
                          position = COALESCE($7, position)
          WHERE id = $1 AND server_id = $2`,
        [roleId, serverId, input.name ?? null, input.color !== undefined, input.color ?? null, input.permissions ?? null, input.position ?? null],
      );
      await audit(tx, serverId, me, 'role.update', roleId, input);
    });
    await dispatcher.serverSync(serverId);
    const updated = (await memberContext(db, serverId, me)).roles.find((r) => r.id === roleId)!;
    return toRole(updated);
  });

  app.delete('/servers/:serverId/roles/:roleId', async (req, reply) => {
    const me = authOf(req).user.id;
    const { serverId, roleId } = parseBody(roleParams, req.params);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.MANAGE_ROLES);
    const role = ctx.roles.find((r) => r.id === roleId);
    if (!role) throw notFound('Cargo não encontrado.');
    if (role.is_default) throw new AppError(400, ErrorCode.VALIDATION, 'O @everyone não pode ser excluído.');
    if (!ctx.isOwner && role.position >= ctx.top) throw hierarchyError();
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM roles WHERE id = $1', [roleId]);
      await tx.query("DELETE FROM channel_overwrites WHERE target_type = 'role' AND target_id = $1", [roleId]);
      await tx.query('UPDATE roles SET position = position - 1 WHERE server_id = $1 AND position > $2 AND NOT is_default', [serverId, role.position]);
      await audit(tx, serverId, me, 'role.delete', roleId, { name: role.name });
    });
    await dispatcher.serverSync(serverId);
    return reply.status(204).send();
  });

  /* ---------------- convites ---------------- */

  app.post('/servers/:serverId/invites', async (req, reply): Promise<Invite> => {
    const me = authOf(req).user.id;
    const { serverId } = parseBody(serverParams, req.params);
    const input = parseBody(createInviteSchema, req.body);
    const ctx = await memberContext(db, serverId, me);
    requirePerm(ctx.basePerms, Permission.CREATE_INVITES);
    const code = inviteCode();
    const expiresAt = input.maxAgeSeconds ? new Date(Date.now() + input.maxAgeSeconds * 1000) : null;
    await db.query('INSERT INTO invites (code, server_id, inviter_id, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5)', [
      code,
      serverId,
      me,
      input.maxUses,
      expiresAt,
    ]);
    await audit(db, serverId, me, 'invite.create', null, { code, ...input });
    const users = await loadPublicUsers(db, [me]);
    return reply.status(201).send({
      code,
      serverId,
      inviter: users.get(me) ?? null,
      maxUses: input.maxUses,
      uses: 0,
      expiresAt: expiresAt?.toISOString() ?? null,
      createdAt: new Date().toISOString(),
    });
  });

  app.get('/servers/:serverId/invites', async (req): Promise<Invite[]> => {
    const { serverId } = parseBody(serverParams, req.params);
    const ctx = await memberContext(db, serverId, authOf(req).user.id);
    requirePerm(ctx.basePerms, Permission.MANAGE_INVITES);
    const { rows } = await db.query<{ code: string; inviter_id: string; max_uses: number; uses: number; expires_at: Date | null; created_at: Date }>(
      `SELECT * FROM invites WHERE server_id = $1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now()) AND (max_uses = 0 OR uses < max_uses)
       ORDER BY created_at DESC`,
      [serverId],
    );
    const users = await loadPublicUsers(db, rows.map((r) => r.inviter_id));
    return rows.map((r) => ({
      code: r.code,
      serverId,
      inviter: users.get(r.inviter_id) ?? null,
      maxUses: r.max_uses,
      uses: r.uses,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  });

  app.delete('/invites/:code', async (req, reply) => {
    const me = authOf(req).user.id;
    const { code } = parseBody(inviteParams, req.params);
    const { rows } = await db.query<{ server_id: string; inviter_id: string }>('SELECT server_id, inviter_id FROM invites WHERE code = $1', [code]);
    if (!rows[0]) throw notFound('Convite não encontrado.');
    const ctx = await memberContext(db, rows[0].server_id, me);
    // Quem criou pode revogar o próprio convite; demais precisam de MANAGE_INVITES.
    if (rows[0].inviter_id !== me) requirePerm(ctx.basePerms, Permission.MANAGE_INVITES);
    await db.query('UPDATE invites SET revoked_at = now() WHERE code = $1', [code]);
    await audit(db, rows[0].server_id, me, 'invite.revoke', null, { code });
    return reply.status(204).send();
  });

  async function validInvite(code: string) {
    const { rows } = await db.query<{ server_id: string; expires_at: Date | null; max_uses: number; uses: number; revoked_at: Date | null }>(
      'SELECT * FROM invites WHERE code = $1',
      [code],
    );
    const inv = rows[0];
    const usable =
      inv && !inv.revoked_at && (!inv.expires_at || new Date(inv.expires_at).getTime() > Date.now()) && (inv.max_uses === 0 || inv.uses < inv.max_uses);
    if (!usable) throw notFound('Convite inválido ou expirado.');
    return inv;
  }

  app.get('/invites/:code', async (req): Promise<InvitePreview> => {
    const { code } = parseBody(inviteParams, req.params);
    const inv = await validInvite(code);
    const { rows } = await db.query<ServerRow & { n: number }>(
      'SELECT s.*, (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS n FROM servers s WHERE s.id = $1',
      [inv.server_id],
    );
    const s = rows[0]!;
    return {
      code,
      server: { id: s.id, name: s.name, description: s.description },
      memberCount: s.n,
      expiresAt: inv.expires_at ? new Date(inv.expires_at).toISOString() : null,
    };
  });

  app.post('/invites/:code', { config: { rateLimit: { max: app.config.rateLimit.inviteJoinsPerMinute, timeWindow: '1 minute' } } }, async (req) => {
    const me = authOf(req).user.id;
    const { code } = parseBody(inviteParams, req.params);
    const inv = await validInvite(code);
    const { rows: already } = await db.query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [inv.server_id, me]);
    if (already.length === 0) {
      await db.transaction(async (tx) => {
        // A condição no UPDATE garante o limite de usos mesmo com entradas simultâneas.
        const { rows } = await tx.query(
          `UPDATE invites SET uses = uses + 1 WHERE code = $1 AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now()) AND (max_uses = 0 OR uses < max_uses) RETURNING code`,
          [code],
        );
        if (rows.length === 0) throw notFound('Convite inválido ou expirado.');
        await tx.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [inv.server_id, me]);
        await audit(tx, inv.server_id, me, 'member.join', me, { code });
      });
      await dispatcher.membersChanged(inv.server_id);
    }
    return serverDetail(db, inv.server_id, me);
  });

  /* ---------------- auditoria ---------------- */

  app.get('/servers/:serverId/audit-log', async (req): Promise<AuditEntry[]> => {
    const { serverId } = parseBody(serverParams, req.params);
    const ctx = await memberContext(db, serverId, authOf(req).user.id);
    requirePerm(ctx.basePerms, Permission.VIEW_AUDIT_LOG);
    const { rows } = await db.query<{ id: string; actor_id: string; action: string; target_id: string | null; details: Record<string, unknown>; created_at: Date }>(
      'SELECT * FROM audit_log WHERE server_id = $1 ORDER BY id DESC LIMIT 100',
      [serverId],
    );
    const users = await loadPublicUsers(db, rows.map((r) => r.actor_id));
    return rows.map((r) => ({
      id: r.id,
      actor: users.get(r.actor_id) ?? null,
      action: r.action,
      targetId: r.target_id,
      details: r.details,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  });
}
