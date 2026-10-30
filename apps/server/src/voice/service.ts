import { createHmac } from 'node:crypto';
import {
  Permission,
  PLAY_MAX_MINUTES,
  STREAM_MAX_VIEWERS,
  VOICE_MAX_PARTICIPANTS,
  hasPermission,
  type DispatchEvent,
  type IceServerConfig,
  type PlayControl,
  type StreamState,
  type StreamSurface,
  type VoiceErrorCode,
  type VoiceParticipantState,
  type VoiceSignal,
} from '@nexo/protocol';
import type { Config } from '../config';
import type { Db } from '../db';
import type { Dispatcher } from '../gateway/dispatch';
import type { Connection, Hub } from '../gateway/hub';
import { channelAccess, loadChannel, type ChannelRow } from '../permissions/service';
import { isBlockedEitherWay } from '../users/public';

interface Participant extends Omit<VoiceParticipantState, 'stream'> {
  connId: string;
  stream: (Omit<StreamState, 'viewers'> & { viewers: Set<string> }) | null;
}

/**
 * Credenciais TURN temporárias no padrão "TURN REST API" (coturn `use-auth-secret`):
 * usuário = "<expira-em-unix>:<id>", senha = base64(HMAC-SHA1(segredo, usuário)).
 * O segredo nunca sai do servidor e a credencial expira sozinha.
 */
export function turnCredential(secret: string, userId: string, ttlSeconds: number, now = Date.now()) {
  const username = `${Math.floor(now / 1000) + ttlSeconds}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

class VoiceError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Estado de voz em memória (um processo). Quem está em qual canal, por qual conexão.
 * Toda entrada é autorizada no servidor, e a autorização é refeita quando cargos/canais mudam:
 * perder CONNECT_VOICE ou VIEW_CHANNEL tira a pessoa da chamada; perder SPEAK a marca como suprimida.
 */
export class VoiceService {
  private readonly channels = new Map<string, Map<string, Participant>>();
  private readonly userChannel = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
    private readonly dispatcher: Dispatcher,
    private readonly config: Config,
    private readonly log: (err: unknown, msg: string) => void = () => {},
  ) {
    hub.onConnectionClosed((conn) => {
      const channelId = this.userChannel.get(conn.userId);
      const p = channelId ? this.channels.get(channelId)?.get(conn.userId) : undefined;
      // Só sai se a conexão que caiu é a que estava na chamada (outro dispositivo pode estar).
      if (p?.connId === conn.id) void this.leave(conn.userId).catch((e) => this.log(e, 'falha ao sair da voz'));
    });
  }

  participants(channelId: string): VoiceParticipantState[] {
    return [...(this.channels.get(channelId)?.values() ?? [])].map(publicState);
  }

  channelOf(userId: string): string | undefined {
    return this.userChannel.get(userId);
  }

  iceServersFor(userId: string): { iceServers: IceServerConfig[]; relayAvailable: boolean } {
    const { stunUrls, turnUrls, turnSecret, turnTtlSeconds } = this.config.voice;
    const iceServers: IceServerConfig[] = [];
    if (stunUrls.length) iceServers.push({ urls: stunUrls });
    const relayAvailable = turnUrls.length > 0 && !!turnSecret;
    if (relayAvailable) iceServers.push({ urls: turnUrls, ...turnCredential(turnSecret, userId, turnTtlSeconds) });
    return { iceServers, relayAvailable };
  }

  /** Avalia se o usuário pode estar em voz neste canal e se pode falar. */
  private async authorize(channelId: string, userId: string): Promise<{ channel: ChannelRow; suppressed: boolean; canStream: boolean; canVideo: boolean }> {
    let access;
    try {
      access = await channelAccess(this.db, channelId, userId);
    } catch {
      throw new VoiceError('NOT_FOUND', 'Canal não encontrado.');
    }
    const { channel, perms } = access;
    if (channel.type === 'dm') {
      const other = access.dmRecipients!.find((u) => u !== userId)!;
      if (await isBlockedEitherWay(this.db, userId, other)) throw new VoiceError('BLOCKED', 'Não é possível ligar para essa pessoa.');
      return { channel, suppressed: false, canStream: true, canVideo: true };
    }
    if (channel.type !== 'voice') throw new VoiceError('NOT_FOUND', 'Este canal não é de voz.');
    if (!hasPermission(perms, Permission.CONNECT_VOICE)) throw new VoiceError('FORBIDDEN', 'Você não tem permissão para entrar neste canal de voz.');
    return {
      channel,
      suppressed: !hasPermission(perms, Permission.SPEAK),
      canStream: hasPermission(perms, Permission.STREAM),
      canVideo: hasPermission(perms, Permission.VIDEO),
    };
  }

  async join(conn: Connection, channelId: string): Promise<void> {
    try {
      const { channel, suppressed } = await this.authorize(channelId, conn.userId);
      const members = this.channels.get(channelId);
      const already = members?.get(conn.userId);
      if (!already && (members?.size ?? 0) >= VOICE_MAX_PARTICIPANTS) {
        throw new VoiceError('FULL', `Este canal está cheio (máximo de ${VOICE_MAX_PARTICIPANTS} pessoas nesta versão).`);
      }
      // Uma chamada por pessoa: entrar em outra sala (ou por outro dispositivo) encerra a anterior.
      if (this.userChannel.has(conn.userId)) await this.leave(conn.userId);

      const p: Participant = { userId: conn.userId, connId: conn.id, selfMute: false, selfDeaf: false, suppressed, joinedAt: new Date().toISOString(), stream: null, camera: null };
      let map = this.channels.get(channelId);
      if (!map) this.channels.set(channelId, (map = new Map()));
      map.set(conn.userId, p);
      this.userChannel.set(conn.userId, channelId);

      const { iceServers, relayAvailable } = this.iceServersFor(conn.userId);
      this.hub.sendToConnection(conn.id, {
        op: 'dispatch',
        event: { type: 'VOICE_READY', channelId, participants: this.participants(channelId), iceServers, relayAvailable },
      });
      await this.broadcast(channel, conn.userId, publicState(p));
    } catch (err) {
      if (!(err instanceof VoiceError)) throw err;
      this.hub.sendToConnection(conn.id, { op: 'dispatch', event: { type: 'VOICE_ERROR', channelId, code: err.code, message: err.message } });
    }
  }

  async leave(userId: string): Promise<void> {
    const channelId = this.userChannel.get(userId);
    if (!channelId) return;
    const map = this.channels.get(channelId);
    const p = map?.get(userId);
    map?.delete(userId);
    if (map?.size === 0) this.channels.delete(channelId);
    this.userChannel.delete(userId);
    // Quem saiu deixa de assistir a qualquer transmissão da sala.
    const stoppedWatching = [...(map?.values() ?? [])].filter((o) => {
      const was = !!o.stream?.viewers.delete(userId);
      // Quem saiu também perde qualquer controle que tivesse.
      const ctl = o.stream?.control?.guestId === userId;
      if (ctl) this.clearControl(o);
      return was || ctl;
    });
    if (p) this.clearControl(p);
    // Quem saiu recebe o aviso diretamente: pode ter perdido acesso ao canal e não estar mais entre os "viewers".
    const event: DispatchEvent = { type: 'VOICE_STATE_UPDATE', channelId, userId, state: null };
    if (p) this.hub.sendToConnection(p.connId, { op: 'dispatch', event });
    const channel = await loadChannel(this.db, channelId).catch(() => null);
    if (channel) {
      await this.dispatcher.toChannel(channel, event, undefined);
      for (const o of stoppedWatching) await this.broadcast(channel, o.userId, publicState(o));
    } else for (const other of map?.values() ?? []) this.hub.sendToConnection(other.connId, { op: 'dispatch', event });
  }

  private own(conn: Connection): { channelId: string; p: Participant } | null {
    const channelId = this.userChannel.get(conn.userId);
    const p = channelId ? this.channels.get(channelId)?.get(conn.userId) : undefined;
    return channelId && p && p.connId === conn.id ? { channelId, p } : null;
  }

  private streamError(conn: Connection, channelId: string, message: string, kind: 'screen' | 'camera' | 'play' = 'screen') {
    this.hub.sendToConnection(conn.id, { op: 'dispatch', event: { type: 'STREAM_ERROR', channelId, message, kind } });
  }

  /** Liga (streamId) ou desliga (null) a câmera. Ligar exige VIDEO no canal, verificado agora. */
  async setCamera(conn: Connection, streamId: string | null): Promise<void> {
    const own = this.own(conn);
    if (!own) return;
    if (streamId === null) {
      if (!own.p.camera) return;
      own.p.camera = null;
    } else {
      let canVideo = false;
      try {
        ({ canVideo } = await this.authorize(own.channelId, conn.userId));
      } catch {
        return this.streamError(conn, own.channelId, 'Você não tem mais acesso a este canal.', 'camera');
      }
      if (!canVideo) return this.streamError(conn, own.channelId, 'Você não tem permissão para usar a câmera neste canal.', 'camera');
      own.p.camera = { streamId, startedAt: own.p.camera?.startedAt ?? new Date().toISOString() };
    }
    await this.broadcast(await loadChannel(this.db, own.channelId), conn.userId, publicState(own.p));
  }

  /**
   * Começa (ou atualiza) a transmissão. A permissão é verificada agora, no servidor: sem STREAM,
   * o estado não muda e os outros clientes não exibem vídeo dessa pessoa (eles só mostram
   * transmissões que o servidor anunciou).
   */
  async startStream(conn: Connection, surface: StreamSurface, hasAudio: boolean, streamId: string): Promise<void> {
    const own = this.own(conn);
    if (!own) return;
    let canStream = false;
    try {
      ({ canStream } = await this.authorize(own.channelId, conn.userId));
    } catch {
      return this.streamError(conn, own.channelId, 'Você não tem mais acesso a este canal.');
    }
    if (!canStream) return this.streamError(conn, own.channelId, 'Você não tem permissão para transmitir neste canal.');
    own.p.stream = own.p.stream
      ? { ...own.p.stream, surface, hasAudio, streamId }
      : { streamId, surface, hasAudio, startedAt: new Date().toISOString(), viewers: new Set(), control: null };
    await this.broadcast(await loadChannel(this.db, own.channelId), conn.userId, publicState(own.p));
  }

  async stopStream(conn: Connection): Promise<void> {
    const own = this.own(conn);
    if (!own?.p.stream) return;
    this.clearControl(own.p);
    own.p.stream = null;
    await this.broadcast(await loadChannel(this.db, own.channelId), conn.userId, publicState(own.p));
  }

  /** Entrar/sair da lista de espectadores. Só entre pessoas na mesma sala, e só se houver transmissão. */
  async watch(conn: Connection, streamerId: string, watching: boolean): Promise<void> {
    const own = this.own(conn);
    if (!own || streamerId === conn.userId) return;
    const streamer = this.channels.get(own.channelId)?.get(streamerId);
    if (!streamer?.stream) {
      if (watching) this.streamError(conn, own.channelId, 'Essa transmissão já terminou.');
      return;
    }
    if (watching === streamer.stream.viewers.has(conn.userId)) return;
    if (watching && streamer.stream.viewers.size >= STREAM_MAX_VIEWERS) {
      return this.streamError(conn, own.channelId, 'Essa transmissão atingiu o limite de espectadores.');
    }
    if (watching) streamer.stream.viewers.add(conn.userId);
    else {
      streamer.stream.viewers.delete(conn.userId);
      // Parar de assistir encerra o controle: não se controla o que não se vê.
      if (streamer.stream.control?.guestId === conn.userId) this.clearControl(streamer);
    }
    await this.broadcast(await loadChannel(this.db, own.channelId), streamerId, publicState(streamer));
  }

  /* ---------------- Jogar Juntos ---------------- */

  private readonly playTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastPlayRequest = new Map<string, number>();

  /** Tira o controle (sem anunciar: quem chama decide quando transmitir o novo estado). */
  private clearControl(host: Participant) {
    const t = this.playTimers.get(host.userId);
    if (t) clearTimeout(t);
    this.playTimers.delete(host.userId);
    if (host.stream) host.stream.control = null;
  }

  /** Quem assiste pede para jogar. Só chega ao dono da transmissão; sem efeito até ele aprovar. */
  async playRequest(conn: Connection, hostId: string): Promise<void> {
    const own = this.own(conn);
    if (!own || hostId === conn.userId) return;
    const host = this.channels.get(own.channelId)?.get(hostId);
    if (!host?.stream || !host.stream.viewers.has(conn.userId)) {
      return this.streamError(conn, own.channelId, 'Para pedir o controle, assista à transmissão primeiro.', 'play');
    }
    if (host.stream.control?.guestId === conn.userId) return;
    const key = `:${hostId}`;
    const now = Date.now();
    // Um pedido a cada 15 s por pessoa: evita insistência/spam de pedidos.
    if (now - (this.lastPlayRequest.get(key) ?? 0) < 15_000) {
      return this.streamError(conn, own.channelId, 'Aguarde um pouco antes de pedir de novo.', 'play');
    }
    this.lastPlayRequest.set(key, now);
    this.hub.sendToConnection(host.connId, { op: 'dispatch', event: { type: 'PLAY_REQUEST', channelId: own.channelId, from: conn.userId } });
  }

  /**
   * O dono da transmissão concede (ou ajusta) o controle. Só para quem está assistindo agora, com pelo
   * menos um tipo de entrada e prazo de 1 a 120 minutos. Um controlador por vez: conceder a outra
   * pessoa tira o controle de quem tinha.
   */
  async playGrant(conn: Connection, g: { guestId: string; keyboard: boolean; mouse: boolean; gamepad: boolean; minutes: number }): Promise<void> {
    const own = this.own(conn);
    if (!own?.p.stream) return;
    if (!own.p.stream.viewers.has(g.guestId)) {
      return this.streamError(conn, own.channelId, 'Só é possível dar controle para quem está assistindo à sua transmissão.', 'play');
    }
    if (!g.keyboard && !g.mouse && !g.gamepad) return this.streamError(conn, own.channelId, 'Escolha ao menos um tipo de entrada.', 'play');
    const minutes = Math.min(PLAY_MAX_MINUTES, Math.max(1, Math.round(g.minutes)));
    this.clearControl(own.p);
    const now = Date.now();
    const control: PlayControl = {
      guestId: g.guestId,
      keyboard: g.keyboard,
      mouse: g.mouse,
      gamepad: g.gamepad,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + minutes * 60_000).toISOString(),
    };
    own.p.stream.control = control;
    const hostId = conn.userId;
    const channelId = own.channelId;
    this.playTimers.set(
      hostId,
      setTimeout(() => {
        const host = this.channels.get(channelId)?.get(hostId);
        if (host?.stream?.control !== control) return;
        this.clearControl(host);
        void loadChannel(this.db, channelId)
          .then((ch) => this.broadcast(ch, hostId, publicState(host)))
          .catch((e) => this.log(e, 'falha ao expirar controle'));
      }, minutes * 60_000),
    );
    await this.broadcast(await loadChannel(this.db, own.channelId), conn.userId, publicState(own.p));
  }

  async playDecline(conn: Connection, guestId: string): Promise<void> {
    const own = this.own(conn);
    const guest = own ? this.channels.get(own.channelId)?.get(guestId) : undefined;
    if (!own || !guest) return;
    this.hub.sendToConnection(guest.connId, { op: 'dispatch', event: { type: 'PLAY_DECLINED', channelId: own.channelId, hostId: conn.userId } });
  }

  /** O dono tira o controle na hora. */
  async playRevoke(conn: Connection): Promise<void> {
    const own = this.own(conn);
    if (!own?.p.stream?.control) return;
    this.clearControl(own.p);
    await this.broadcast(await loadChannel(this.db, own.channelId), conn.userId, publicState(own.p));
  }

  /** Quem controla devolve o controle. */
  async playRelease(conn: Connection, hostId: string): Promise<void> {
    const own = this.own(conn);
    const host = own ? this.channels.get(own.channelId)?.get(hostId) : undefined;
    if (!own || !host || host.stream?.control?.guestId !== conn.userId) return;
    this.clearControl(host);
    await this.broadcast(await loadChannel(this.db, own.channelId), hostId, publicState(host));
  }

  async setState(conn: Connection, selfMute: boolean, selfDeaf: boolean): Promise<void> {
    const channelId = this.userChannel.get(conn.userId);
    const p = channelId ? this.channels.get(channelId)?.get(conn.userId) : undefined;
    if (!channelId || !p || p.connId !== conn.id) return;
    p.selfMute = selfMute || selfDeaf;
    p.selfDeaf = selfDeaf;
    const channel = await loadChannel(this.db, channelId);
    await this.broadcast(channel, conn.userId, publicState(p));
  }

  /** Retransmite sinalização WebRTC — só entre duas pessoas na mesma sala, conexão a conexão. */
  signal(conn: Connection, to: string, signal: VoiceSignal): void {
    const channelId = this.userChannel.get(conn.userId);
    if (!channelId || channelId !== this.userChannel.get(to)) return;
    const map = this.channels.get(channelId)!;
    if (map.get(conn.userId)?.connId !== conn.id) return;
    const target = map.get(to);
    if (target) this.hub.sendToConnection(target.connId, { op: 'dispatch', event: { type: 'VOICE_SIGNAL', channelId, from: conn.userId, signal } });
  }

  /** Toque de chamada privada: quem liga precisa já estar na conversa de voz da DM. */
  async ring(conn: Connection, channelId: string): Promise<void> {
    if (this.userChannel.get(conn.userId) !== channelId) return;
    const access = await channelAccess(this.db, channelId, conn.userId).catch(() => null);
    if (!access?.dmRecipients) return;
    const other = access.dmRecipients.find((u) => u !== conn.userId)!;
    if (this.userChannel.get(other) === channelId) return;
    this.dispatcher.toUsers([other], { type: 'CALL_RING', channelId, from: conn.userId });
  }

  /** Recusar não abre microfone nem conexão: só avisa quem ligou. */
  async decline(conn: Connection, channelId: string): Promise<void> {
    const access = await channelAccess(this.db, channelId, conn.userId).catch(() => null);
    if (!access?.dmRecipients) return;
    const other = access.dmRecipients.find((u) => u !== conn.userId)!;
    this.dispatcher.toUsers([other, conn.userId], { type: 'CALL_DECLINE', channelId, userId: conn.userId });
  }

  /** Refaz a autorização de quem está em voz nos canais de um servidor (cargos/canais/membros mudaram). */
  async revalidateServer(serverId: string): Promise<void> {
    for (const [channelId, map] of [...this.channels]) {
      const channel = await loadChannel(this.db, channelId).catch(() => null);
      if (!channel) {
        for (const userId of [...map.keys()]) await this.leave(userId);
        continue;
      }
      if (channel.server_id !== serverId) continue;
      for (const p of [...map.values()]) {
        try {
          const { suppressed, canStream, canVideo } = await this.authorize(channelId, p.userId);
          const lostStream = !canStream && p.stream !== null;
          const lostCamera = !canVideo && p.camera !== null;
          if (suppressed !== p.suppressed || lostStream || lostCamera) {
            p.suppressed = suppressed;
            if (lostStream) {
              this.clearControl(p);
              p.stream = null;
            }
            if (lostCamera) p.camera = null;
            await this.broadcast(channel, p.userId, publicState(p));
          }
        } catch {
          await this.leave(p.userId);
        }
      }
    }
  }

  /** Estados de voz que o usuário pode ver (para montar a barra lateral ao abrir o app). */
  async visibleStates(userId: string): Promise<Record<string, VoiceParticipantState[]>> {
    const out: Record<string, VoiceParticipantState[]> = {};
    for (const channelId of this.channels.keys()) {
      const ok = await channelAccess(this.db, channelId, userId).then(
        () => true,
        () => false,
      );
      if (ok) out[channelId] = this.participants(channelId);
    }
    return out;
  }

  private async broadcast(channel: ChannelRow, userId: string, state: VoiceParticipantState | null) {
    await this.dispatcher.toChannel(channel, { type: 'VOICE_STATE_UPDATE', channelId: channel.id, userId, state });
  }
}

const publicState = (p: Participant): VoiceParticipantState => ({
  userId: p.userId,
  selfMute: p.selfMute,
  selfDeaf: p.selfDeaf,
  suppressed: p.suppressed,
  joinedAt: p.joinedAt,
  stream: p.stream
    ? {
        streamId: p.stream.streamId,
        surface: p.stream.surface,
        hasAudio: p.stream.hasAudio,
        startedAt: p.stream.startedAt,
        viewers: [...p.stream.viewers],
        control: p.stream.control,
      }
    : null,
  camera: p.camera,
});
