import type { FastifyInstance } from 'fastify';
import { authOf, requireAuth } from '../auth/guard';

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Quem está em voz agora, só nos canais que o usuário pode ver. */
  app.get('/voice/states', async (req) => app.voice.visibleStates(authOf(req).user.id));
}
