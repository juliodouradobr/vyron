import type { IceServerConfig, VoiceSignal } from '@nexo/protocol';
import { tuneOpus } from './opus';
import type { EncodingParams } from './screen/quality';
import { summarizeRecv, summarizeSend, toList, type Counters, type VideoRecvStats, type VideoSendStats } from './screen/stats';

export interface PeerStats {
  state: RTCPeerConnectionState;
  rttMs: number | null;
  jitterMs: number | null;
  /** Fração de pacotes perdidos desde a última coleta (0–1). */
  loss: number | null;
  sendKbps: number | null;
  recvKbps: number | null;
  /** host = rede local, srflx = direto via NAT (IPs visíveis), relay = via TURN (IP oculto). */
  route: 'host' | 'srflx' | 'prflx' | 'relay' | null;
}

/** Mídias de vídeo que enviamos além da voz. */
export type MediaKind = 'screen' | 'camera';
export const MEDIA_KINDS: readonly MediaKind[] = ['screen', 'camera'];

/** Uma fonte de vídeo (com áudio opcional, só na tela). */
export interface MediaSource {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
}

export type EncodingFor = (userId: string) => { params: EncodingParams; degradation: RTCDegradationPreference } | null;

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  sender: RTCRtpSender | null;
  joinedAt: string;
  last: { at: number; lost: number; received: number; sent: number; recv: number } | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Nossos transceptores por tipo de mídia (criados na primeira vez; reaproveitados depois). */
  tx: Partial<Record<MediaKind, { video: RTCRtpTransceiver; audio: RTCRtpTransceiver | null }>>;
  sendCounters: Partial<Record<MediaKind, Counters>>;
  /** Mídias desta pessoa que chegam até nós, pelo id do MediaStream (é o que o servidor anuncia). */
  remote: Map<string, MediaStream>;
  videoReceivers: Map<string, RTCRtpReceiver>;
  recvCounters: Map<string, Counters>;
  /** Canal de entrada do Jogar Juntos (dados, ponta a ponta, criptografado pelo DTLS da conexão). */
  input: RTCDataChannel | null;
}

export interface MeshOptions {
  selfId: string;
  iceServers: IceServerConfig[];
  relayOnly: boolean;
  getTrack: () => MediaStreamTrack;
  sendSignal: (to: string, signal: VoiceSignal) => void;
  onRemoteStream: (userId: string, stream: MediaStream) => void;
  /** Vídeo (tela ou câmera) recebido de alguém, identificado pelo id do stream. */
  onRemoteMedia: (userId: string, streamId: string, stream: MediaStream) => void;
  onPeerState: (userId: string, state: RTCPeerConnectionState) => void;
  /** Mensagem de entrada recebida (Jogar Juntos). Quem recebe decide se aceita; aqui nada é aplicado. */
  onInput?: (userId: string, data: unknown) => void;
}

interface Outgoing {
  source: MediaSource | null;
  /** 'all' = todos da sala (câmera); conjunto = só essas pessoas (tela: quem assiste). */
  targets: Set<string> | 'all';
  encoding: EncodingFor;
}

/**
 * Uma RTCPeerConnection por participante, com o padrão "perfect negotiation":
 * os dois lados podem oferecer a qualquer momento; em colisão, o lado "educado" (polite) cede.
 * Polidez é determinística (compara ids), então os dois concordam sem combinar nada.
 */
export class PeerMesh {
  private readonly peers = new Map<string, Peer>();
  private maxBitrate = 40_000;
  /**
   * Um MediaStream "contêiner" por tipo, só para dar um id estável ao msid do SDP: quem recebe usa
   * esse id para saber se o vídeo é tela ou câmera, e ele não muda quando a fonte é trocada.
   */
  private readonly containers: Record<MediaKind, MediaStream> = { screen: new MediaStream(), camera: new MediaStream() };
  private readonly out: Record<MediaKind, Outgoing> = {
    screen: { source: null, targets: new Set(), encoding: () => null },
    camera: { source: null, targets: 'all', encoding: () => null },
  };

  constructor(private readonly o: MeshOptions) {}

  /** Id que anunciamos ao servidor para cada tipo de mídia. */
  streamId(kind: MediaKind): string {
    return this.containers[kind].id;
  }

  has(userId: string): boolean {
    return this.peers.has(userId);
  }

  /** Cria (ou recria, se a pessoa reentrou) a conexão com um participante. */
  ensure(userId: string, joinedAt: string): void {
    const existing = this.peers.get(userId);
    if (existing && existing.joinedAt === joinedAt) return;
    if (existing) this.remove(userId);

    const pc = new RTCPeerConnection({
      iceServers: this.o.iceServers,
      iceTransportPolicy: this.o.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    const peer: Peer = {
      pc,
      polite: this.o.selfId < userId,
      makingOffer: false,
      ignoreOffer: false,
      sender: null,
      joinedAt,
      last: null,
      disconnectTimer: null,
      tx: {},
      sendCounters: {},
      remote: new Map(),
      videoReceivers: new Map(),
      recvCounters: new Map(),
      input: null,
    };
    this.peers.set(userId, peer);

    peer.sender = pc.addTrack(this.o.getTrack(), new MediaStream([this.o.getTrack()]));
    void this.applyBitrate(peer);
    // Canal negociado com id fixo nos dois lados: existe desde o início, sem renegociar depois.
    // Ordenado e confiável: uma tecla solta nunca pode se perder (evita tecla presa).
    const input = pc.createDataChannel('vyron-input', { negotiated: true, id: 7, ordered: true });
    input.onmessage = (ev) => this.o.onInput?.(userId, ev.data);
    peer.input = input;

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') });
        this.o.sendSignal(userId, { kind: 'description', description: { type: 'offer', sdp: pc.localDescription!.sdp } });
      } catch (err) {
        console.warn('[voz] falha ao criar oferta', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      this.o.sendSignal(userId, {
        kind: 'candidate',
        candidate: candidate ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } : null,
      });
    };
    pc.ontrack = ({ streams, track, transceiver }) => {
      // O microfone usa o transceptor que criamos com addTrack (m-line compartilhada sendrecv).
      if (track.kind === 'audio' && transceiver.sender === peer.sender) {
        this.o.onRemoteStream(userId, streams[0] ?? new MediaStream([track]));
        return;
      }
      // Tela ou câmera: agrupadas pelo id do stream (msid) que o outro lado anunciou ao servidor.
      const streamId = streams[0]?.id ?? `faixa-${track.id}`;
      let ms = peer.remote.get(streamId);
      if (!ms) peer.remote.set(streamId, (ms = new MediaStream()));
      if (!ms.getTrackById(track.id)) {
        for (const old of ms.getTracks()) if (old.kind === track.kind) ms.removeTrack(old);
        ms.addTrack(track);
      }
      if (track.kind === 'video') peer.videoReceivers.set(streamId, transceiver.receiver);
      this.o.onRemoteMedia(userId, streamId, ms);
    };
    for (const kind of MEDIA_KINDS) void this.syncMedia(kind, userId, peer);
    pc.onconnectionstatechange = () => {
      this.o.onPeerState(userId, pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
      // "disconnected" pode se resolver sozinho; se persistir, tenta outra rota.
      if (pc.connectionState === 'disconnected' && !peer.disconnectTimer) {
        peer.disconnectTimer = setTimeout(() => {
          peer.disconnectTimer = null;
          if (pc.connectionState === 'disconnected') pc.restartIce();
        }, 4000);
      }
    };
  }

  async handleSignal(from: string, signal: VoiceSignal, joinedAt: string | undefined): Promise<void> {
    if (!this.peers.has(from)) {
      if (!joinedAt) return; // sinal de quem não está na sala: ignora
      this.ensure(from, joinedAt);
    }
    const peer = this.peers.get(from)!;
    const { pc } = peer;
    try {
      if (signal.kind === 'description') {
        const desc = signal.description;
        const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(desc as RTCSessionDescriptionInit);
        if (desc.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp ?? '') });
          this.o.sendSignal(from, { kind: 'description', description: { type: 'answer', sdp: pc.localDescription!.sdp } });
        }
      } else {
        try {
          await pc.addIceCandidate(signal.candidate ?? undefined);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('[voz] falha ao processar sinalização', err);
    }
  }

  remove(userId: string): void {
    const p = this.peers.get(userId);
    if (!p) return;
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = null;
    if (p.input) p.input.onmessage = null;
    p.pc.close();
    this.peers.delete(userId);
  }

  /** Troca o microfone (ex.: headset desconectado) sem renegociar. */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    await Promise.all([...this.peers.values()].map((p) => p.sender?.replaceTrack(track)));
  }

  async setMaxBitrate(bps: number): Promise<void> {
    if (bps === this.maxBitrate) return;
    this.maxBitrate = bps;
    await Promise.all([...this.peers.values()].map((p) => this.applyBitrate(p)));
  }

  private async applyBitrate(p: Peer) {
    if (!p.sender) return;
    try {
      const params = p.sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0]!.maxBitrate = this.maxBitrate;
      // Prioridade de rede alta: voz passa na frente do vídeo quando a rede aperta.
      params.encodings[0]!.networkPriority = 'high';
      params.encodings[0]!.priority = 'high';
      await p.sender.setParameters(params);
    } catch {
      /* antes da negociação os parâmetros ainda não podem ser aplicados; nova tentativa no próximo ajuste */
    }
  }

  async stats(): Promise<Record<string, PeerStats>> {
    const out: Record<string, PeerStats> = {};
    await Promise.all(
      [...this.peers].map(async ([userId, p]) => {
        const report = await p.pc.getStats().catch(() => null);
        const s: PeerStats = { state: p.pc.connectionState, rttMs: null, jitterMs: null, loss: null, sendKbps: null, recvKbps: null, route: null };
        if (!report) return void (out[userId] = s);
        // Só a m-line do microfone conta para a voz (áudio da tela tem a sua).
        const micMid = p.pc.getTransceivers().find((t) => t.sender === p.sender)?.mid ?? null;
        const isMic = (r: { mid?: string }) => micMid == null || r.mid == null || r.mid === micMid;
        let lost = 0, received = 0, sent = 0, recv = 0, localId: string | undefined;
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
            if (typeof r.currentRoundTripTime === 'number') s.rttMs = Math.round(r.currentRoundTripTime * 1000);
            localId = r.localCandidateId;
          } else if (r.type === 'inbound-rtp' && r.kind === 'audio' && isMic(r)) {
            lost += r.packetsLost ?? 0;
            received += r.packetsReceived ?? 0;
            recv += r.bytesReceived ?? 0;
            if (typeof r.jitter === 'number') s.jitterMs = Math.round(r.jitter * 1000);
          } else if (r.type === 'outbound-rtp' && r.kind === 'audio' && isMic(r)) {
            sent += r.bytesSent ?? 0;
          }
        });
        if (localId) s.route = (report.get(localId)?.candidateType as PeerStats['route']) ?? null;
        const now = performance.now();
        if (p.last) {
          const dt = (now - p.last.at) / 1000;
          const dLost = Math.max(0, lost - p.last.lost);
          const dRecv = Math.max(0, received - p.last.received);
          s.loss = dLost + dRecv > 0 ? dLost / (dLost + dRecv) : 0;
          s.sendKbps = Math.round(((sent - p.last.sent) * 8) / dt / 1000);
          s.recvKbps = Math.round(((recv - p.last.recv) * 8) / dt / 1000);
        }
        p.last = { at: now, lost, received, sent, recv };
        out[userId] = s;
      }),
    );
    return out;
  }

  /* ---------------- vídeo: tela e câmera ---------------- */

  /**
   * Define o que enviamos de um tipo de mídia e para quem. Tela: só para quem assiste (segundo o
   * servidor). Câmera: para todos da sala. Para quem não é alvo, nada é enviado.
   */
  async setMedia(kind: MediaKind, source: MediaSource | null, targets: Iterable<string> | 'all', encoding: EncodingFor): Promise<void> {
    this.out[kind] = { source, targets: targets === 'all' ? 'all' : new Set(targets), encoding };
    await Promise.all([...this.peers].map(([id, p]) => this.syncMedia(kind, id, p)));
  }

  private wants(kind: MediaKind, userId: string): boolean {
    const o = this.out[kind];
    return !!o.source && (o.targets === 'all' || o.targets.has(userId));
  }

  private async syncMedia(kind: MediaKind, userId: string, p: Peer): Promise<void> {
    const src = this.out[kind].source;
    const container = this.containers[kind];
    const tx = p.tx[kind];
    try {
      if (src && this.wants(kind, userId)) {
        if (!tx) {
          // Síncrono (antes de qualquer await): a ordem das m-lines fica previsível.
          const video = p.pc.addTransceiver(src.video, { direction: 'sendonly', streams: [container] });
          const audio = src.audio ? p.pc.addTransceiver(src.audio, { direction: 'sendonly', streams: [container] }) : null;
          p.tx[kind] = { video, audio };
        } else {
          await this.attach(tx.video, src.video);
          if (src.audio) {
            if (tx.audio) await this.attach(tx.audio, src.audio);
            else tx.audio = p.pc.addTransceiver(src.audio, { direction: 'sendonly', streams: [container] });
          } else if (tx.audio) await this.detach(tx.audio);
        }
        await this.applyEncoding(kind, userId, p);
      } else if (tx) {
        await this.detach(tx.video);
        if (tx.audio) await this.detach(tx.audio);
        delete p.sendCounters[kind];
      }
    } catch (err) {
      console.warn(`[${kind === 'screen' ? 'tela' : 'câmera'}] falha ao atualizar o envio para um participante`, err);
    }
  }

  /** Reaproveita o transceptor: trocar a faixa e reativar a direção dispara uma renegociação pequena. */
  private async attach(t: RTCRtpTransceiver, track: MediaStreamTrack) {
    if (t.sender.track !== track) await t.sender.replaceTrack(track);
    if (t.direction !== 'sendonly') t.direction = 'sendonly';
  }

  private async detach(t: RTCRtpTransceiver) {
    if (t.sender.track) await t.sender.replaceTrack(null);
    if (t.direction !== 'inactive') t.direction = 'inactive';
  }

  /** Aplica (de novo) os parâmetros do codificador de vídeo para uma pessoa. */
  async applyEncoding(kind: MediaKind, userId: string, p = this.peers.get(userId)): Promise<void> {
    const tx = p?.tx[kind]?.video;
    const enc = this.out[kind].encoding(userId);
    if (!tx || !enc || tx.direction !== 'sendonly') return;
    try {
      const params = tx.sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      const e = params.encodings[0]!;
      e.maxBitrate = enc.params.maxBitrate;
      e.maxFramerate = enc.params.maxFramerate;
      e.scaleResolutionDownBy = enc.params.scaleResolutionDownBy;
      // Voz tem prioridade sobre o vídeo quando a rede aperta.
      e.priority = 'low';
      e.networkPriority = 'low';
      params.degradationPreference = enc.degradation;
      await tx.sender.setParameters(params);
    } catch {
      /* antes da negociação terminar os parâmetros ainda não podem ser aplicados; o próximo ciclo tenta de novo */
    }
  }

  /**
   * Estatísticas de vídeo: o que enviamos (por tipo e por pessoa) e o que recebemos
   * (por pessoa e por id de stream).
   */
  async videoStats(): Promise<{
    send: Record<MediaKind, Record<string, VideoSendStats>>;
    recv: Record<string, Record<string, VideoRecvStats>>;
  }> {
    const send: Record<MediaKind, Record<string, VideoSendStats>> = { screen: {}, camera: {} };
    const recv: Record<string, Record<string, VideoRecvStats>> = {};
    const now = performance.now();
    await Promise.all(
      [...this.peers].map(async ([id, p]) => {
        for (const kind of MEDIA_KINDS) {
          const tx = p.tx[kind]?.video;
          if (!tx || tx.direction !== 'sendonly') continue;
          const r = await tx.sender.getStats().catch(() => null);
          const s = r ? summarizeSend(toList(r), p.sendCounters[kind] ?? null, now) : null;
          if (s) {
            send[kind][id] = s.stats;
            p.sendCounters[kind] = s.counters;
          }
        }
        for (const [streamId, receiver] of p.videoReceivers) {
          if (receiver.track.readyState !== 'live' || receiver.track.muted) continue;
          const r = await receiver.getStats().catch(() => null);
          const s = r ? summarizeRecv(toList(r), p.recvCounters.get(streamId) ?? null, now) : null;
          if (s) {
            (recv[id] ??= {})[streamId] = s.stats;
            p.recvCounters.set(streamId, s.counters);
          }
        }
      }),
    );
    return { send, recv };
  }

  /** Envia uma entrada (Jogar Juntos). Descarta se o canal não estiver aberto ou estiver congestionado. */
  sendInput(userId: string, data: string): boolean {
    const ch = this.peers.get(userId)?.input;
    if (!ch || ch.readyState !== 'open' || ch.bufferedAmount > 64 * 1024) return false;
    ch.send(data);
    return true;
  }

  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.remove(id);
  }
}
