import type { FastifyInstance } from 'fastify';
import { GatewayClose, loginSchema, recoverySchema, registerSchema } from '@nexo/protocol';
import { parseBody } from '../http/errors';
import { authOf, requireAuth } from './guard';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { auth, hub, config } = app;
  // Limite mais rígido por IP nas rotas que aceitam segredos.
  const strict = { rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: '1 minute' } };

  app.post('/auth/register', { config: strict }, async (req, reply) => {
    const input = parseBody(registerSchema, req.body);
    return reply.status(201).send(await auth.register(input));
  });

  app.post('/auth/login', { config: strict }, async (req) => {
    return auth.login(parseBody(loginSchema, req.body));
  });

  app.post('/auth/recover', { config: strict }, async (req) => {
    const { revokedSessionIds, ...res } = await auth.recover(parseBody(recoverySchema, req.body));
    hub.closeSessions(revokedSessionIds, GatewayClose.SESSION_REVOKED, 'acesso recuperado');
    return res;
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const ctx = authOf(req);
    await auth.logout(ctx.sessionId);
    hub.closeSessions([ctx.sessionId], GatewayClose.SESSION_REVOKED, 'sessão encerrada');
    return reply.status(204).send();
  });
}
