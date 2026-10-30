import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GatewayClose,
  changePasswordSchema,
  regenerateRecoveryCodesSchema,
  updateProfileSchema,
  userSettingsSchema,
  type SettingsResponse,
} from '@nexo/protocol';
import { authOf, requireAuth } from '../auth/guard';
import { notFound, parseBody } from '../http/errors';
import { findUserById, toSelfUser } from './repo';

const sessionIdParams = z.object({ id: z.string().uuid() });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { auth, hub, db, config } = app;
  const strict = { rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: '1 minute' } };

  app.addHook('preHandler', requireAuth);

  app.get('/users/@me', async (req) => authOf(req).user);

  app.patch('/users/@me', async (req) => {
    const ctx = authOf(req);
    const input = parseBody(updateProfileSchema, req.body);
    // Lista fixa de colunas: o cliente nunca escolhe quais campos são gravados.
    await db.query(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         bio = COALESCE($3, bio),
         status = COALESCE($4, status)
       WHERE id = $1`,
      [ctx.user.id, input.displayName ?? null, input.bio ?? null, input.status ?? null],
    );
    const row = await findUserById(db, ctx.user.id);
    if (!row) throw notFound();
    const user = toSelfUser(row);
    if (input.status) hub.setStatus(user.id, user.status);
    hub.sendToUser(user.id, { op: 'dispatch', event: { type: 'USER_UPDATE', user } });
    return user;
  });

  app.post('/users/@me/password', { config: strict }, async (req, reply) => {
    const ctx = authOf(req);
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
    const revoked = await auth.changePassword(ctx, currentPassword, newPassword);
    hub.closeSessions(revoked, GatewayClose.SESSION_REVOKED, 'senha alterada');
    return reply.status(204).send();
  });

  app.post('/users/@me/recovery-codes', { config: strict }, async (req) => {
    const { password } = parseBody(regenerateRecoveryCodesSchema, req.body);
    return { recoveryCodes: await auth.regenerateRecoveryCodes(authOf(req), password) };
  });

  app.get('/users/@me/sessions', async (req) => auth.listSessions(authOf(req)));

  app.delete('/users/@me/sessions/:id', async (req, reply) => {
    const ctx = authOf(req);
    const { id } = parseBody(sessionIdParams, req.params);
    if (!(await auth.revokeSession(ctx, id))) throw notFound('Sessão não encontrada.');
    hub.closeSessions([id], GatewayClose.SESSION_REVOKED, 'sessão encerrada');
    return reply.status(204).send();
  });

  app.delete('/users/@me/sessions', async (req) => {
    const revoked = await auth.revokeOtherSessions(authOf(req));
    hub.closeSessions(revoked, GatewayClose.SESSION_REVOKED, 'sessão encerrada');
    return { revoked: revoked.length };
  });

  app.get('/users/@me/settings', async (req): Promise<SettingsResponse> => {
    const { rows } = await db.query<{ data: unknown; updated_at: Date }>(
      'SELECT data, updated_at FROM user_settings WHERE user_id = $1',
      [authOf(req).user.id],
    );
    // Reaplicar o schema garante padrões para campos adicionados depois que a linha foi gravada.
    const settings = userSettingsSchema.parse(rows[0]?.data ?? {});
    return { settings, updatedAt: rows[0] ? new Date(rows[0].updated_at).toISOString() : null };
  });

  app.put('/users/@me/settings', async (req): Promise<SettingsResponse> => {
    const settings = parseBody(userSettingsSchema, req.body);
    const { rows } = await db.query<{ updated_at: Date }>(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
       RETURNING updated_at`,
      [authOf(req).user.id, JSON.stringify(settings)],
    );
    return { settings, updatedAt: new Date(rows[0]!.updated_at).toISOString() };
  });
}
