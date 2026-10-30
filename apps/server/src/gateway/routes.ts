import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayClose, MEDIA_STREAM_ID_RE, PLAY_MAX_MINUTES, presenceStatusSchema, type ServerMessage } from '@nexo/protocol';
import type { AuthContext } from '../auth/service';
import { canType } from '../channels/routes';
import type { Connection } from './hub';

const clientMessageSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('identify'), token: z.string().max(128) }),
  z.object({ op: z.literal('heartbeat'), seq: z.number().int().nonnegative() }),
  z.object({ op: z.literal('set_status'), status: presenceStatusSchema }),
  z.object({ op: z.literal('typing'), channelId: z.string().uuid() }),
  z.object({ op: z.literal('voice_join'), channelId: z.string().uuid() }),
  z.object({ op: z.literal('voice_leave') }),
  z.object({ op: z.literal('voice_state'), selfMute: z.boolean(), selfDeaf: z.boolean() }),
  z.object({
    op: z.literal('voice_signal'),
    to: z.string().uuid(),
    signal: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('description'),
        // Com vídeo (vários codecs) a SDP cresce bastante em relação a só áudio.
        description: z.object({ type: z.enum(['offer', 'answer', 'pranswer', 'rollback']), sdp: z.string().max(48_000).optional() }),
      }),
      z.object({
        kind: z.literal('candidate'),
        candidate: z
          .object({ candidate: z.string().max(1024), sdpMid: z.string().max(64).nullish(), sdpMLineIndex: z.number().int().min(0).max(64).nullish() })
          .nullable(),
      }),
    ]),
  }),
  z.object({
    op: z.literal('stream_start'),
    surface: z.enum(['monitor', 'window', 'browser', 'unknown']),
    hasAudio: z.boolean(),
    streamId: z.string().regex(MEDIA_STREAM_ID_RE),
  }),
  z.object({ op: z.literal('play_request'), hostId: z.string().uuid() }),
  z.object({
    op: z.literal('play_grant'),
    guestId: z.string().uuid(),
    keyboard: z.boolean(),
    mouse: z.boolean(),
    gamepad: z.boolean(),
    minutes: z.number().int().min(1).max(PLAY_MAX_MINUTES),
  }),
  z.object({ op: z.literal('play_decline'), guestId: z.string().uuid() }),
  z.object({ op: z.literal('play_revoke') }),
  z.object({ op: z.literal('play_release'), hostId: z.string().uuid() }),
  z.object({ op: z.literal('camera_on'), streamId: z.string().regex(MEDIA_STREAM_ID_RE) }),
  z.object({ op: z.literal('camera_off') }),
  z.object({ op: z.literal('stream_stop') }),
  z.object({ op: z.literal('stream_watch'), userId: z.string().uuid(), watching: z.boolean() }),
  z.object({ op: z.literal('call_ring'), channelId: z.string().uuid() }),
  z.object({ op: z.literal('call_decline'), channelId: z.string().uuid() }),
]);

/** Um aviso de "digitando" por canal a cada 3 s por conexão basta para a interface. */
const TYPING_THROTTLE_MS = 3000;

const MAX_MESSAGES_PER_10S = 60;
/** Sinalização WebRTC vem em rajadas (vários candidatos ICE por pessoa): limite próprio. */
const MAX_SIGNALS_PER_10S = 400;

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  const { config, hub, auth, db } = app;
  const { heartbeatIntervalMs, identifyTimeoutMs, maxConnectionsPerUser } = config.gateway;

  app.get('/gateway', { websocket: true }, (socket, req) => {
    // Navegadores não aplicam CORS a WebSocket; validamos a origem quando ela é informada.
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes(origin)) {
      socket.close(GatewayClose.PROTOCOL_ERROR, 'origem não permitida');
      return;
    }

    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    let ctx: AuthContext | undefined;
    let conn: Connection | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let windowStart = Date.now();
    let windowCount = 0;
    let signalCount = 0;
    const lastTyping = new Map<string, number>();

    const close = (code: number, reason: string) => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
    };

    // Tolerância de 50% sobre o intervalo para absorver atrasos de rede.
    const armHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => close(GatewayClose.HEARTBEAT_TIMEOUT, 'heartbeat perdido'), heartbeatIntervalMs * 1.5);
    };

    const identifyTimer = setTimeout(() => close(GatewayClose.PROTOCOL_ERROR, 'identify não recebido'), identifyTimeoutMs);
    send({ op: 'hello', heartbeatIntervalMs });

    socket.on('message', async (raw: Buffer) => {
      const now = Date.now();
      if (now - windowStart > 10_000) {
        windowStart = now;
        windowCount = 0;
        signalCount = 0;
      }

      let parsed: z.infer<typeof clientMessageSchema>;
      try {
        parsed = clientMessageSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return close(GatewayClose.PROTOCOL_ERROR, 'mensagem inválida');
      }
      const tooMany = parsed.op === 'voice_signal' ? ++signalCount > MAX_SIGNALS_PER_10S : ++windowCount > MAX_MESSAGES_PER_10S;
      if (tooMany) return close(GatewayClose.PROTOCOL_ERROR, 'mensagens demais');

      if (parsed.op === 'identify') {
        if (ctx) return close(GatewayClose.PROTOCOL_ERROR, 'já identificado');
        clearTimeout(identifyTimer);
        try {
          ctx = await auth.authenticate(parsed.token);
        } catch {
          return close(GatewayClose.AUTH_FAILED, 'autenticação falhou');
        }
        if (socket.readyState !== socket.OPEN) return;
        if (hub.connectionCount(ctx.user.id) >= maxConnectionsPerUser) {
          return close(GatewayClose.TOO_MANY_CONNECTIONS, 'conexões demais');
        }
        conn = { id: randomUUID(), userId: ctx.user.id, sessionId: ctx.sessionId, send, close };
        hub.add(conn, ctx.user.status);
        armHeartbeat();
        send({ op: 'ready', user: ctx.user, sessionId: ctx.sessionId });
        return;
      }

      if (!ctx) return close(GatewayClose.PROTOCOL_ERROR, 'identify necessário');

      if (parsed.op === 'heartbeat') {
        armHeartbeat();
        send({ op: 'heartbeat_ack', seq: parsed.seq });
      } else if (parsed.op === 'set_status') {
        try {
          await db.query('UPDATE users SET status = $2 WHERE id = $1', [ctx.user.id, parsed.status]);
        } catch (err) {
          req.log.error({ err }, 'falha ao salvar status');
          return;
        }
        ctx = { ...ctx, user: { ...ctx.user, status: parsed.status } };
        hub.setStatus(ctx.user.id, parsed.status);
        hub.sendToUser(ctx.user.id, { op: 'dispatch', event: { type: 'USER_UPDATE', user: ctx.user } });
      } else if (parsed.op === 'typing') {
        if (now - (lastTyping.get(parsed.channelId) ?? 0) < TYPING_THROTTLE_MS) return;
        lastTyping.set(parsed.channelId, now);
        const userId = ctx.user.id;
        try {
          // Mesma checagem do envio de mensagens: sem SEND_MESSAGES, o aviso é descartado em silêncio.
          const access = await canType(app, parsed.channelId, userId);
          if (access) await app.dispatcher.toChannel(access.channel, { type: 'TYPING_START', channelId: parsed.channelId, userId }, userId);
        } catch (err) {
          req.log.error({ err }, 'falha ao publicar digitação');
        }
      } else if (conn) {
        const c = conn;
        try {
          if (parsed.op === 'voice_join') await app.voice.join(c, parsed.channelId);
          else if (parsed.op === 'voice_leave') {
            if (app.voice.channelOf(c.userId)) await app.voice.leave(c.userId);
          } else if (parsed.op === 'voice_state') await app.voice.setState(c, parsed.selfMute, parsed.selfDeaf);
          else if (parsed.op === 'voice_signal') app.voice.signal(c, parsed.to, parsed.signal);
          else if (parsed.op === 'stream_start') await app.voice.startStream(c, parsed.surface, parsed.hasAudio, parsed.streamId);
          else if (parsed.op === 'play_request') await app.voice.playRequest(c, parsed.hostId);
          else if (parsed.op === 'play_grant') await app.voice.playGrant(c, parsed);
          else if (parsed.op === 'play_decline') await app.voice.playDecline(c, parsed.guestId);
          else if (parsed.op === 'play_revoke') await app.voice.playRevoke(c);
          else if (parsed.op === 'play_release') await app.voice.playRelease(c, parsed.hostId);
          else if (parsed.op === 'camera_on') await app.voice.setCamera(c, parsed.streamId);
          else if (parsed.op === 'camera_off') await app.voice.setCamera(c, null);
          else if (parsed.op === 'stream_stop') await app.voice.stopStream(c);
          else if (parsed.op === 'stream_watch') await app.voice.watch(c, parsed.userId, parsed.watching);
          else if (parsed.op === 'call_ring') await app.voice.ring(c, parsed.channelId);
          else if (parsed.op === 'call_decline') await app.voice.decline(c, parsed.channelId);
        } catch (err) {
          req.log.error({ err, op: parsed.op }, 'falha em operação de voz');
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(identifyTimer);
      clearTimeout(heartbeatTimer);
      if (conn) hub.remove(conn);
    });
  });
}
