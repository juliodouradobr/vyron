import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ErrorCode } from '@nexo/protocol';
import { AuthService } from './auth/service';
import { authRoutes } from './auth/routes';
import type { Config } from './config';
import type { Db } from './db';
import { gatewayRoutes } from './gateway/routes';
import { Hub } from './gateway/hub';
import { AppError, installErrorHandler } from './http/errors';
import { userRoutes } from './users/routes';
import { socialRoutes } from './social/routes';
import { serverRoutes } from './servers/routes';
import { channelRoutes } from './channels/routes';
import { Dispatcher } from './gateway/dispatch';
import { VoiceService } from './voice/service';
import { voiceRoutes } from './voice/routes';
import { FileService } from './files/service';
import { fileRoutes } from './files/routes';
import { createStore } from './files/store';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    auth: AuthService;
    hub: Hub;
    dispatcher: Dispatcher;
    voice: VoiceService;
    files: FileService;
  }
}

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Nunca registrar tokens ou senhas.
            redact: ['req.headers.authorization', 'req.body.password', 'req.body.newPassword', 'req.body.currentPassword'],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  const hub = new Hub(config.gateway.offlineGraceMs);
  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('auth', new AuthService(db, config));
  app.decorate('hub', hub);
  const logError = (err: unknown, msg: string) => app.log.error({ err }, msg);
  const dispatcher = new Dispatcher(db, hub, logError);
  const voice = new VoiceService(db, hub, dispatcher, config, logError);
  dispatcher.onServerChanged((serverId) => voice.revalidateServer(serverId));
  app.decorate('dispatcher', dispatcher);
  app.decorate('voice', voice);
  const files = new FileService(db, createStore(config.files.dir), config, logError);
  app.decorate('files', files);
  // Limpeza de anexos abandonados e conteúdo sem dono: ao iniciar e a cada 10 minutos.
  const sweep = () => void files.sweep().catch((e) => logError(e, 'falha na limpeza de arquivos'));
  const sweepTimer = setInterval(sweep, 10 * 60_000);
  sweepTimer.unref();
  app.addHook('onReady', async () => sweep());
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    hub.shutdown();
  });

  installErrorHandler(app);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // Arquivos definem o próprio cache (privado); o resto da API nunca é guardado.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  await app.register(rateLimit, {
    max: config.rateLimit.globalPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) =>
      new AppError(429, ErrorCode.RATE_LIMITED, 'Muitas requisições. Tente novamente em instantes.', {
        retryAfter: Math.ceil(ctx.ttl / 1000),
      }),
  });

  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.get('/api/v1/health', { config: { rateLimit: false } }, async () => ({ ok: true, db: db.driver }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(socialRoutes);
      await api.register(serverRoutes);
      await api.register(channelRoutes);
      await api.register(voiceRoutes);
      await api.register(fileRoutes);
    },
    { prefix: '/api/v1' },
  );
  await app.register(gatewayRoutes);

  return app;
}
