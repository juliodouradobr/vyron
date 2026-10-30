import type { ClientMessage, DispatchEvent, PlayControl } from '@nexo/protocol';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../services/platform';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';
import { useVoice, type NoiseState, type ViewerSendState } from '../stores/voice';
import { NoiseNode, measureNeuralCostUs, type NoiseStats } from './dsp/noiseNode';
import { usesNeural, type NoiseMode } from './dsp/suppressor';
import { BITRATE_STEPS, adapt, initialAdapt, type AdaptState } from './adaptation';
import { gate, type GateState } from './gate';
import { MicError, MicPipeline, listDevices, micOptionsFrom, setContextSink } from './MicPipeline';
import { PeerMesh } from './PeerMesh';
import { cameraConstraints, cameraEncoding, cameraErrorMessage, loadCameraPrefs, type CameraQuality } from './camera';
import { VIDEO_LEVELS, adaptVideo, initialVideoAdapt, type VideoAdaptState } from './screen/adapt';
import { RESOLUTIONS, captureOptions, contentHintFor, degradationFor, encodingFor, type StreamQuality } from './screen/quality';
import { explainSend } from './screen/stats';
import { InputGuard, describeInput, parseInput, type InputMsg } from './play/input';
import { MonitorSink, NativeSink, nativeInputAvailable, type InputSink } from './play/sink';
import { Playback } from './Playback';
import { playJoin, playLeave, playMute, playUnmute, startRingtone } from './sounds';

const READY_TIMEOUT_MS = 10_000;
const RING_TIMEOUT_MS = 30_000;
const SPEAKING_DB_MARGIN = 6;
/** Acima disso (µs por 10 ms = 30% de um núcleo) o modelo neural não é viável neste computador. */
const NEURAL_MAX_COST_US = 3000;
/** Carga na thread de áudio que, repetida, indica que o computador não está dando conta. */
const OVERLOAD_PCT = 50;
const OVERLOAD_STRIKES = 2;

type Send = (msg: ClientMessage) => void;

/**
 * Orquestra uma sessão de voz: microfone → portão (mute/ativação por voz/PTT) → malha P2P,
 * e áudio recebido → reprodução com volume por pessoa. Uma sessão por vez.
 * Toda decisão de quem pode entrar/falar é do servidor; aqui só aplicamos o que ele diz.
 */
class VoiceController {
  private send: Send = () => {};
  private ctx: AudioContext | null = null;
  private mic: MicPipeline | null = null;
  private mesh: PeerMesh | null = null;
  private playback: Playback | null = null;
  private gateState: GateState = { open: false, lastVoiceAt: 0 };
  private adaptState: AdaptState = initialAdapt();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRing: (() => void) | null = null;
  private leaving = false;
  private unsubs: Array<() => void> = [];
  private noise: NoiseNode | null = null;
  private noiseUnsub: (() => void) | null = null;
  /** Caiu para Economia nesta sessão (desempenho ou falha); escolher outro modo desfaz. */
  private noiseFallback = false;
  private overloadStrikes = 0;
  /** Captura de tela em andamento (faixas reais) e adaptação por espectador. */
  private capture: { stream: MediaStream; video: MediaStreamTrack; audio: MediaStreamTrack | null; quality: StreamQuality } | null = null;
  private videoAdapt = new Map<string, VideoAdaptState>();
  /** Jogar Juntos, lado do anfitrião: guarda da sessão atual e destino das entradas. */
  private playGuard: InputGuard | null = null;
  private playSink: InputSink | null = null;
  /** Identifica a autorização vigente (muda a cada nova concessão). */
  private playGrantKey: string | null = null;
  private playRecent: string[] = [];
  private playFlush: ReturnType<typeof setTimeout> | null = null;
  /** Janela escolhida para receber o controle (app para Windows). */
  private playWindow: { id: number; title: string } | null = null;
  /** Câmera ligada (faixa real) e a qualidade pedida. */
  private cam: { stream: MediaStream; video: MediaStreamTrack; quality: CameraQuality } | null = null;

  attach(send: Send) {
    this.send = send;
  }

  get store() {
    return useVoice.getState();
  }

  private get selfId() {
    return useSession.getState().user?.id ?? '';
  }

  /* ---------------- entrar / sair ---------------- */

  async join(channelId: string): Promise<void> {
    const v = this.store;
    if (v.channelId === channelId && v.status !== 'error') return;
    if (v.channelId) this.teardown(false);
    v.patch({ channelId, status: 'connecting', error: null, notice: null, peers: {}, speaking: {} });
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 });
      await this.ctx.resume();
      const s = useSettings.getState().settings;
      try {
        this.mic = await MicPipeline.open(this.ctx, this.micOptions());
        if (this.mic.fellBackToDefault) v.patch({ notice: 'O microfone escolhido não está disponível; usando o padrão do sistema.' });
      } catch (err) {
        // Sem microfone (ou acesso negado): entra só para ouvir, como esperado em apps de voz.
        if (!(err instanceof MicError) || (err.kind !== 'denied' && err.kind !== 'not_found')) throw err;
        this.mic = MicPipeline.silent(this.ctx);
        v.patch({ notice: `Você entrou só para ouvir. ${err.message}` });
      }
      v.patch({ listenOnly: this.mic.listenOnly });
      this.playback = new Playback(this.ctx);
      await setContextSink(this.ctx, s.outputDeviceId);
      this.applyOutput();
      // Sem esperar: até o modelo carregar, a voz passa sem supressão (nunca atrasa a entrada).
      void this.applyNoise();
    } catch (err) {
      this.fail(err instanceof MicError ? err.message : 'Não foi possível iniciar o áudio.');
      return;
    }
    if (this.store.channelId !== channelId) return; // cancelado enquanto pedia o microfone
    this.send({ op: 'voice_join', channelId });
    this.readyTimer = setTimeout(() => this.fail('O servidor de voz não respondeu. Tente de novo.'), READY_TIMEOUT_MS);
  }

  leave(): void {
    if (!this.store.channelId) return;
    this.leaving = true;
    this.send({ op: 'voice_leave' });
    this.teardown(true);
    this.leaving = false;
  }

  /** Liga para alguém numa DM: entra na sala da conversa e toca no outro lado. */
  async call(dmChannelId: string): Promise<void> {
    await this.join(dmChannelId);
    if (this.store.status === 'error') return;
    this.store.patch({ outgoingCall: { channelId: dmChannelId, startedAt: Date.now() } });
  }

  async acceptCall(): Promise<void> {
    const inc = this.store.incomingCall;
    if (!inc) return;
    this.clearRing();
    this.store.patch({ incomingCall: null });
    await this.join(inc.channelId);
  }

  declineCall(): void {
    const inc = this.store.incomingCall;
    if (!inc) return;
    this.clearRing();
    this.send({ op: 'call_decline', channelId: inc.channelId });
    this.store.patch({ incomingCall: null });
  }

  /** Gateway reconectou: o servidor esqueceu a sessão, então entramos de novo na mesma sala. */
  onReconnect(): void {
    const { channelId, status } = this.store;
    if (!channelId || status === 'error' || !this.mic) return;
    this.mesh?.closeAll();
    this.mesh = null;
    this.store.patch({ status: 'connecting' });
    this.send({ op: 'voice_join', channelId });
    this.readyTimer = setTimeout(() => this.fail('Não foi possível voltar à sala de voz.'), READY_TIMEOUT_MS);
  }

  shutdown(): void {
    this.declineCall();
    this.teardown(false);
    this.store.patch({ rooms: {}, incomingCall: null, outgoingCall: null, error: null, notice: null });
  }

  /* ---------------- eventos do servidor ---------------- */

  handle(e: DispatchEvent): void {
    const v = this.store;
    switch (e.type) {
      case 'VOICE_STATE_UPDATE': {
        v.setRoom(e.channelId, e.userId, e.state);
        if (e.channelId !== v.channelId) {
          // Quem ligou desistiu antes de atendermos.
          if (!e.state && v.incomingCall?.channelId === e.channelId && v.incomingCall.from === e.userId) {
            this.clearRing();
            v.patch({ incomingCall: null, notice: 'Chamada perdida.' });
          }
          return;
        }
        if (e.userId === this.selfId) {
          // O servidor nos tirou da sala (outro dispositivo entrou, permissão retirada, expulsão).
          if (!e.state && !this.leaving && v.status === 'connected') {
            this.teardown(true);
            this.store.patch({ notice: 'Você foi desconectado da sala de voz.' });
          }
          if (e.state) {
            this.updateGate();
            this.onSelfState(e.state.stream);
            void this.syncPlayHost(e.state.stream?.control ?? null);
            this.onSelfCamera(e.state.camera);
          }
          return;
        }
        if (e.state) {
          this.onOtherPlayState(e.userId, e.state.stream?.control ?? null);
          if (!this.mesh?.has(e.userId)) playJoin();
          this.mesh?.ensure(e.userId, e.state.joinedAt);
          this.playback?.setSuppressed(e.userId, e.state.suppressed);
          if (v.outgoingCall?.channelId === e.channelId) this.endRinging();
        } else {
          this.mesh?.remove(e.userId);
          this.playback?.remove(e.userId);
          this.videoAdapt.delete(e.userId);
          playLeave();
          const cur = useVoice.getState();
          const { [e.userId]: _p, ...peers } = cur.peers;
          const { [e.userId]: _s, ...remoteMedia } = cur.remoteMedia;
          const { [e.userId]: _r, ...mediaRecv } = cur.mediaRecv;
          v.patch({ peers, remoteMedia, mediaRecv, focusedStream: cur.focusedStream === e.userId ? null : cur.focusedStream });
        }
        return;
      }
      case 'VOICE_READY': {
        if (e.channelId !== v.channelId || !this.mic) return;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        const relayOnly = useSettings.getState().settings.voiceRelayOnly;
        if (relayOnly && !e.relayAvailable) {
          this.send({ op: 'voice_leave' });
          this.fail('"Ocultar meu IP" exige um servidor TURN, que não está configurado neste servidor. Desative a opção ou peça ao administrador.');
          return;
        }
        // A lista do READY é a verdade sobre a sala: substitui o que tínhamos dela.
        v.patch({ relayAvailable: e.relayAvailable, rooms: { ...v.rooms, [e.channelId]: Object.fromEntries(e.participants.map((p) => [p.userId, p])) } });
        this.mesh = new PeerMesh({
          selfId: this.selfId,
          iceServers: e.iceServers,
          relayOnly,
          getTrack: () => this.mic!.track,
          sendSignal: (to, signal) => this.send({ op: 'voice_signal', to, signal }),
          onRemoteStream: (userId, stream) => {
            const st = useVoice.getState().rooms[e.channelId]?.[userId];
            this.playback?.add(userId, stream, useSettings.getState().settings.userVolumes[userId] ?? 1, !!st?.suppressed);
          },
          onRemoteMedia: (userId, streamId, stream) => {
            // Objeto novo a cada faixa nova: a interface percebe a mudança e reatribui o vídeo.
            const all = useVoice.getState().remoteMedia;
            this.store.patch({ remoteMedia: { ...all, [userId]: { ...all[userId], [streamId]: new MediaStream(stream.getTracks()) } } });
          },
          onPeerState: () => {},
          onInput: (userId, data) => this.onPlayInput(userId, data),
        });
        for (const p of e.participants) if (p.userId !== this.selfId) this.mesh.ensure(p.userId, p.joinedAt);
        // Reconexão no meio de uma transmissão: o servidor esqueceu; anunciamos de novo (e ele revalida a permissão).
        if (this.capture && this.store.screen) {
          this.store.patch({ screen: { ...this.store.screen, pending: true } });
          this.send({ op: 'stream_start', surface: this.store.screen.surface, hasAudio: this.store.screen.hasAudio, streamId: this.mesh.streamId('screen') });
          void this.syncScreen();
        }
        if (this.cam && this.store.camera) {
          this.store.patch({ camera: { ...this.store.camera, pending: true } });
          this.send({ op: 'camera_on', streamId: this.mesh.streamId('camera') });
          void this.syncCamera();
        }
        const wasConnecting = v.status !== 'connected';
        v.patch({ status: 'connected' });
        this.pushState();
        this.startLoops();
        if (wasConnecting) playJoin();
        if (v.outgoingCall?.channelId === e.channelId && e.participants.length === 1) {
          this.send({ op: 'call_ring', channelId: e.channelId });
          this.ringTimer = setTimeout(() => {
            if (useVoice.getState().outgoingCall) {
              this.leave();
              this.store.patch({ notice: 'Ninguém atendeu a chamada.' });
            }
          }, RING_TIMEOUT_MS);
        }
        return;
      }
      case 'VOICE_SIGNAL': {
        if (e.channelId !== v.channelId) return;
        const joinedAt = v.rooms[e.channelId]?.[e.from]?.joinedAt;
        void this.mesh?.handleSignal(e.from, e.signal, joinedAt);
        return;
      }
      case 'VOICE_ERROR':
        if (e.channelId === v.channelId) this.fail(e.message);
        return;
      case 'STREAM_ERROR':
        if (e.channelId !== v.channelId) return;
        // Recusado antes de começar (sem permissão): a captura local não pode continuar aberta.
        if (e.kind === 'play') {
          v.patch({ notice: e.message, playPending: null });
        } else if (e.kind === 'camera') {
          if (this.cam) this.stopCamera(e.message);
          else v.patch({ notice: e.message });
        } else if (this.capture && v.screen?.pending) this.stopScreen(e.message);
        else v.patch({ notice: e.message, focusedStream: null });
        return;
      case 'PLAY_REQUEST':
        if (e.channelId !== v.channelId || !v.screen) return;
        if (!v.playRequests.some((r) => r.from === e.from)) v.patch({ playRequests: [...v.playRequests, { from: e.from, at: Date.now() }] });
        return;
      case 'PLAY_DECLINED':
        if (e.channelId !== v.channelId) return;
        v.patch({ playPending: null, notice: 'O pedido para jogar junto foi recusado.' });
        return;
      case 'CALL_RING':
        if (v.channelId === e.channelId || v.incomingCall) return;
        v.patch({ incomingCall: { channelId: e.channelId, from: e.from } });
        this.stopRing?.();
        // "Não perturbe": a chamada aparece, mas sem tocar.
        this.stopRing = useSession.getState().user?.status === 'dnd' ? null : startRingtone();
        this.ringTimer = setTimeout(() => this.declineCall(), RING_TIMEOUT_MS);
        return;
      case 'CALL_DECLINE':
        if (e.userId === this.selfId) {
          // Recusado em outro dispositivo nosso.
          if (v.incomingCall?.channelId === e.channelId) {
            this.clearRing();
            v.patch({ incomingCall: null });
          }
        } else if (v.outgoingCall?.channelId === e.channelId) {
          this.leave();
          this.store.patch({ notice: 'A chamada foi recusada.' });
        }
        return;
    }
  }

  /* ---------------- transmissão de tela ---------------- */

  /** Quem o servidor diz que está assistindo à nossa transmissão. */
  private screenViewers(): string[] {
    const v = this.store;
    return (v.channelId && v.rooms[v.channelId]?.[this.selfId]?.stream?.viewers) || [];
  }

  private encodingFor = (userId: string) => {
    const cap = this.capture;
    if (!cap) return null;
    const level = this.videoAdapt.get(userId)?.level ?? 0;
    return {
      params: encodingFor(cap.quality, { height: cap.video.getSettings().height ?? null }, VIDEO_LEVELS[level]),
      degradation: degradationFor(cap.quality.content),
    };
  };

  private async syncScreen(): Promise<void> {
    const cap = this.capture;
    await this.mesh?.setMedia('screen', cap ? { video: cap.video, audio: cap.audio } : null, cap ? this.screenViewers() : [], this.encodingFor);
  }

  /**
   * Abre o seletor do sistema (tela, janela ou aba) e começa a transmitir. A escolha é sempre da
   * pessoa, no seletor oficial do sistema/navegador; o app não captura nada sem esse passo.
   * Chamar de novo durante uma transmissão troca a fonte sem derrubar quem assiste.
   */
  async startScreen(quality: StreamQuality, withAudio: boolean): Promise<void> {
    const v = this.store;
    if (!v.channelId || v.status !== 'connected' || !this.mesh) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      v.patch({ notice: 'Este ambiente não permite capturar a tela.' });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(captureOptions(quality, withAudio));
    } catch (err) {
      const name = (err as DOMException)?.name;
      // Cancelar o seletor não é erro.
      if (name !== 'NotAllowedError' && name !== 'AbortError') v.patch({ notice: 'Não foi possível capturar a tela.' });
      return;
    }
    if (this.store.channelId !== v.channelId) return void stream.getTracks().forEach((t) => t.stop());
    const video = stream.getVideoTracks()[0];
    if (!video) return void stream.getTracks().forEach((t) => t.stop());
    const audio = stream.getAudioTracks()[0] ?? null;
    video.contentHint = contentHintFor(quality.content);
    const raw = (video.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
    const surface = raw === 'monitor' || raw === 'window' || raw === 'browser' ? raw : 'unknown';

    const previous = this.capture;
    this.capture = { stream, video, audio, quality };
    previous?.stream.getTracks().forEach((t) => t.stop());
    // Parar pelo controle do sistema ("Parar de compartilhar") também encerra aqui.
    video.addEventListener('ended', () => {
      if (this.capture?.video === video) this.stopScreen('A captura da tela foi encerrada.');
    });
    v.patch({
      screen: {
        quality,
        surface,
        hasAudio: !!audio,
        audioUnavailable: withAudio && !audio,
        pending: !previous,
        startedAt: previous ? (this.store.screen?.startedAt ?? Date.now()) : Date.now(),
        preview: stream,
      },
    });
    if (!this.mesh) return;
    this.send({ op: 'stream_start', surface, hasAudio: !!audio, streamId: this.mesh.streamId('screen') });
    await this.syncScreen();
  }

  stopScreen(notice?: string): void {
    if (!this.capture) return;
    this.capture.stream.getTracks().forEach((t) => t.stop());
    this.capture = null;
    this.videoAdapt.clear();
    if (this.store.status === 'connected') this.send({ op: 'stream_stop' });
    void this.syncScreen();
    this.store.patch({ screen: null, screenSend: {}, ...(notice ? { notice } : {}) });
  }

  /** Muda resolução/FPS/tipo de conteúdo sem reiniciar a transmissão. */
  async setScreenQuality(quality: StreamQuality): Promise<void> {
    const cap = this.capture;
    if (!cap) return;
    cap.quality = quality;
    const r = RESOLUTIONS[quality.resolution];
    cap.video.contentHint = contentHintFor(quality.content);
    try {
      await cap.video.applyConstraints({ width: { max: r.width }, height: { max: r.height }, frameRate: { ideal: quality.fps, max: quality.fps } });
    } catch {
      /* a fonte não aceita a mudança na captura; o codificador ainda limita resolução e FPS */
    }
    const screen = this.store.screen;
    if (screen) this.store.patch({ screen: { ...screen, quality } });
    await Promise.all(this.screenViewers().map((id) => this.mesh?.applyEncoding('screen', id)));
  }

  /** Pedir para assistir (ou parar). O servidor decide e avisa a sala; o vídeo só chega depois disso. */
  watch(userId: string, watching: boolean): void {
    if (this.store.status !== 'connected') return;
    this.send({ op: 'stream_watch', userId, watching });
    const v = this.store;
    if (watching) v.patch({ focusedStream: userId });
    else if (v.focusedStream === userId) v.patch({ focusedStream: null });
  }

  private onSelfState(stream: { viewers: string[] } | null) {
    const screen = this.store.screen;
    if (!this.capture || !screen) return;
    if (stream) {
      if (screen.pending) this.store.patch({ screen: { ...screen, pending: false } });
      for (const id of [...this.videoAdapt.keys()]) if (!stream.viewers.includes(id)) this.videoAdapt.delete(id);
      void this.syncScreen();
    } else if (!screen.pending) {
      // O servidor encerrou (permissão retirada): a captura para na hora, sem deixar nada rodando.
      this.stopScreen('Sua transmissão foi encerrada: você não tem mais permissão para transmitir neste canal.');
    }
  }

  private async collectVideoStats() {
    if (!this.mesh) return;
    const { send, recv } = await this.mesh.videoStats();
    const cap = this.capture;
    const screenSend: Record<string, ViewerSendState> = {};
    if (cap) {
      const wanted = { height: RESOLUTIONS[cap.quality.resolution].height, fps: cap.quality.fps };
      for (const [id, st] of Object.entries(send.screen)) {
        const prev = this.videoAdapt.get(id);
        const next = adaptVideo(prev ?? initialVideoAdapt(), { loss: st.loss, rttMs: st.rttMs, limitation: st.limitation });
        this.videoAdapt.set(id, next);
        // Primeira amostra (os parâmetros podem ter sido recusados antes da negociação) ou mudança de nível.
        if (!prev || prev.level !== next.level) void this.mesh.applyEncoding('screen', id);
        screenSend[id] = { ...st, level: next.level, reasons: explainSend(st, wanted, next.level > 0 ? next.reason : null) };
      }
    }
    this.store.patch({ screenSend, mediaRecv: recv, cameraSend: send.camera });
  }

  /* ---------------- Jogar Juntos ---------------- */

  /** Convidado: pedir para jogar. Não muda nada até o anfitrião aprovar. */
  requestPlay(hostId: string): void {
    if (this.store.status !== 'connected') return;
    this.send({ op: 'play_request', hostId });
    this.store.patch({ playPending: { hostId, at: Date.now() } });
  }

  /** Anfitrião: escolher a janela que receberá o controle (app para Windows). */
  setPlayWindow(w: { id: number; title: string } | null): void {
    this.playWindow = w;
  }

  /** Anfitrião: aprovar, com os tipos de entrada e o prazo escolhidos. */
  grantPlay(guestId: string, g: { keyboard: boolean; mouse: boolean; minutes: number }): void {
    this.send({ op: 'play_grant', guestId, keyboard: g.keyboard, mouse: g.mouse, gamepad: false, minutes: g.minutes });
    this.store.patch({ playRequests: this.store.playRequests.filter((r) => r.from !== guestId) });
  }

  declinePlay(guestId: string): void {
    this.send({ op: 'play_decline', guestId });
    this.store.patch({ playRequests: this.store.playRequests.filter((r) => r.from !== guestId) });
  }

  /** Anfitrião: tirar o controle agora. Também solta localmente tudo que estiver pressionado. */
  revokePlay(): void {
    void this.playSink?.disarm();
    this.send({ op: 'play_revoke' });
  }

  /** Convidado: começar/parar de capturar teclado e mouse para a transmissão de alguém. */
  setControlling(hostId: string | null): void {
    const prev = this.store.playControlling;
    if (prev && prev !== hostId) this.sendInput(prev, { t: 'r' });
    this.store.patch({ playControlling: hostId });
  }

  /** Convidado: devolver o controle. */
  releasePlay(hostId: string): void {
    this.setControlling(null);
    this.sendInput(hostId, { t: 'r' });
    this.send({ op: 'play_release', hostId });
  }

  /** Convidado: envia uma entrada já no formato do protocolo. */
  sendInput(hostId: string, m: InputMsg): void {
    this.mesh?.sendInput(hostId, JSON.stringify(m));
  }

  /** Atalho de pânico (Ctrl+Shift+F12): anfitrião revoga; convidado para de controlar. */
  panic(): void {
    const v = this.store;
    const self = v.channelId ? v.rooms[v.channelId]?.[this.selfId] : undefined;
    if (self?.stream?.control) {
      this.revokePlay();
      v.patch({ notice: 'Controle revogado pelo atalho Ctrl+Shift+F12.' });
    }
    if (v.playControlling) this.releasePlay(v.playControlling);
  }

  /** Anfitrião: o servidor mudou quem controla (concedeu, ajustou, revogou, expirou). */
  private async syncPlayHost(control: PlayControl | null): Promise<void> {
    const key = control ? `|${control.grantedAt}|${control.keyboard}|${control.mouse}` : null;
    if (key === this.playGrantKey) return;
    this.playGrantKey = key;
    // Toda mudança começa limpa: solta o que estava pressionado na sessão anterior.
    await this.playSink?.disarm();
    this.playGuard = null;
    this.playSink = null;
    this.playRecent = [];
    if (!control) {
      this.store.patch({ playHost: null });
      return;
    }
    const sink: InputSink = nativeInputAvailable() ? new NativeSink() : new MonitorSink((m) => this.recordPlay(describeInput(m)));
    try {
      await sink.arm({ keyboard: control.keyboard, mouse: control.mouse, windowId: this.playWindow?.id ?? null });
    } catch (err) {
      // Sem janela válida o controle não pode valer: devolvemos a autorização.
      this.send({ op: 'play_revoke' });
      this.store.patch({ notice: err instanceof Error ? err.message : 'Não foi possível preparar o controle remoto.' });
      return;
    }
    this.playSink = sink;
    this.playGuard = new InputGuard(400, 200, Date.now());
    this.store.patch({
      playHost: { sink: sink.kind, accepted: 0, blocked: 0, lastBlock: null, recent: [], windowTitle: this.playWindow?.title ?? null },
    });
  }

  private recordPlay(text: string) {
    this.playRecent = [text, ...this.playRecent].slice(0, 12);
  }

  /** Anfitrião: entrada recebida pela conexão P2P. Nada é aplicado sem passar pela guarda. */
  private onPlayInput(from: string, data: unknown) {
    const v = this.store;
    const control = v.channelId ? (v.rooms[v.channelId]?.[this.selfId]?.stream?.control ?? null) : null;
    const msg = parseInput(data);
    if (!msg || !this.playGuard || !this.playSink) return;
    const verdict = this.playGuard.check(from, msg, control, Date.now());
    if (verdict.ok) this.playSink.apply(msg);
    // Atualiza o painel do anfitrião no máximo 4 vezes por segundo.
    if (!this.playFlush) {
      this.playFlush = setTimeout(() => {
        this.playFlush = null;
        const host = this.store.playHost;
        const g = this.playGuard;
        if (!host || !g) return;
        this.store.patch({ playHost: { ...host, accepted: g.accepted, blocked: g.blocked, lastBlock: g.lastBlockReason, recent: this.playRecent } });
      }, 250);
    }
  }

  /** Convidado: estado da transmissão de outra pessoa mudou. */
  private onOtherPlayState(hostId: string, control: PlayControl | null) {
    const v = this.store;
    const mine = control?.guestId === this.selfId;
    if (mine && v.playPending?.hostId === hostId) v.patch({ playPending: null });
    // Perdeu o controle (revogado, expirou, outra pessoa ganhou): para de capturar na hora.
    if (!mine && v.playControlling === hostId) v.patch({ playControlling: null });
  }

  /* ---------------- câmera ---------------- */

  private async syncCamera(): Promise<void> {
    const cam = this.cam;
    await this.mesh?.setMedia('camera', cam ? { video: cam.video, audio: null } : null, 'all', () =>
      cam ? { params: cameraEncoding(cam.quality, { height: cam.video.getSettings().height ?? null }), degradation: 'balanced' } : null,
    );
  }

  /**
   * Liga a câmera (pede permissão ao sistema) e envia para todos da sala. O servidor confirma a
   * permissão VIDEO; se recusar, a câmera desliga na hora.
   */
  async startCamera(): Promise<void> {
    const v = this.store;
    if (!v.channelId || v.status !== 'connected' || !this.mesh || this.cam) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      v.patch({ notice: 'Este ambiente não permite usar a câmera.' });
      return;
    }
    const prefs = loadCameraPrefs();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(prefs.quality, prefs.deviceId));
    } catch (err) {
      // Câmera escolhida sumiu (desconectada): tenta a padrão antes de desistir.
      if ((err as DOMException)?.name === 'OverconstrainedError' && prefs.deviceId !== 'default') {
        try {
          stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(prefs.quality, 'default'));
          v.patch({ notice: 'A câmera escolhida não está disponível; usando a padrão do sistema.' });
        } catch (err2) {
          v.patch({ notice: cameraErrorMessage(err2) });
          return;
        }
      } else {
        v.patch({ notice: cameraErrorMessage(err) });
        return;
      }
    }
    const video = stream.getVideoTracks()[0];
    if (!video || this.store.channelId !== v.channelId || this.store.status !== 'connected' || !this.mesh) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    video.contentHint = 'motion';
    this.cam = { stream, video, quality: prefs.quality };
    video.addEventListener('ended', () => {
      if (this.cam?.video === video) this.stopCamera('A câmera foi desconectada.');
    });
    this.store.patch({ camera: { quality: prefs.quality, pending: true, startedAt: Date.now(), preview: stream, label: video.label } });
    this.send({ op: 'camera_on', streamId: this.mesh.streamId('camera') });
    await this.syncCamera();
  }

  /** Desliga e libera o dispositivo (a luz da câmera apaga). */
  stopCamera(notice?: string): void {
    if (!this.cam) return;
    this.cam.stream.getTracks().forEach((t) => t.stop());
    this.cam = null;
    if (this.store.status === 'connected') this.send({ op: 'camera_off' });
    void this.syncCamera();
    this.store.patch({ camera: null, cameraSend: {}, ...(notice ? { notice } : {}) });
  }

  toggleCamera(): void {
    if (this.cam) this.stopCamera();
    else void this.startCamera();
  }

  private onSelfCamera(camera: { streamId: string } | null) {
    const local = this.store.camera;
    if (!this.cam || !local) return;
    if (camera) {
      if (local.pending) this.store.patch({ camera: { ...local, pending: false } });
    } else if (!local.pending) {
      // O servidor desligou (permissão retirada): a câmera é liberada na hora.
      this.stopCamera('Sua câmera foi desligada: você não tem mais permissão para usar a câmera neste canal.');
    }
  }

  /* ---------------- supressão de ruído ---------------- */

  private effectiveNoiseMode(): NoiseMode {
    return this.noiseFallback ? 'economy' : useSettings.getState().settings.noiseMode;
  }

  private micOptions() {
    return micOptionsFrom({ ...useSettings.getState().settings, noiseMode: this.effectiveNoiseMode() });
  }

  private patchNoise(p: Partial<NoiseState>) {
    const cur = this.store.noise;
    const base: NoiseState = cur ?? {
      mode: this.effectiveNoiseMode(),
      applied: 'loading',
      noiseReductionDb: null,
      noiseFloorDb: null,
      speechLossDb: null,
      snrDb: null,
      loadPct: null,
      costUs: null,
      fallback: this.noiseFallback,
    };
    this.store.patch({ noise: { ...base, ...p } });
  }

  /** Coloca (ou tira) o nó neural na cadeia do microfone conforme o modo efetivo. */
  private async applyNoise(): Promise<void> {
    const mode = this.effectiveNoiseMode();
    if (!this.ctx || !this.mic || this.mic.listenOnly) return;
    if (!usesNeural(mode)) {
      this.mic.setNoiseNode(null);
      this.dropNoise();
      this.patchNoise({ mode, applied: mode === 'economy' ? 'economy' : 'off', noiseReductionDb: null, snrDb: null, loadPct: null, fallback: this.noiseFallback });
      return;
    }
    this.patchNoise({ mode, fallback: false });
    const cost = await measureNeuralCostUs().catch(() => null);
    this.patchNoise({ costUs: cost });
    if (cost != null && cost > NEURAL_MAX_COST_US) {
      return this.fallbackToEconomy(`A supressão neural custaria ${Math.round(cost / 100)}% de um núcleo neste computador; usando o modo Economia.`);
    }
    if (!this.noise) {
      try {
        const ctx = this.ctx;
        const node = await NoiseNode.create(ctx, mode);
        if (this.ctx !== ctx) return node.destroy(); // a chamada acabou enquanto carregava
        this.noise = node;
        this.overloadStrikes = 0;
        this.noiseUnsub = node.onStats((st) => this.onNoiseStats(st));
      } catch (err) {
        console.warn('[ruído] falha ao carregar', err);
        return this.fallbackToEconomy('Não foi possível carregar a supressão neural; usando o modo Economia.');
      }
    } else this.noise.setMode(mode);
    this.mic?.setNoiseNode(this.noise.node);
  }

  private onNoiseStats(st: NoiseStats) {
    this.patchNoise({
      applied: st.applied === 'passthrough' ? 'off' : st.applied,
      noiseReductionDb: st.noiseReductionDb,
      noiseFloorDb: st.noiseFloorDb,
      speechLossDb: st.speechLossDb,
      snrDb: st.snrDb,
      loadPct: st.loadPct,
    });
    this.overloadStrikes = st.loadPct >= OVERLOAD_PCT ? this.overloadStrikes + 1 : 0;
    if (this.overloadStrikes >= OVERLOAD_STRIKES) {
      void this.fallbackToEconomy('A supressão neural está pesada para este computador agora; mudei para o modo Economia para não prejudicar a chamada.');
    }
  }

  private async fallbackToEconomy(message: string) {
    this.noiseFallback = true;
    this.dropNoise();
    this.store.patch({ notice: message });
    this.patchNoise({ mode: 'economy', applied: 'economy', fallback: true, loadPct: null, noiseReductionDb: null, snrDb: null });
    // A supressão clássica é uma opção da captura: reabre o microfone com ela ligada.
    await this.reopenMic();
  }

  private dropNoise() {
    this.noiseUnsub?.();
    this.noiseUnsub = null;
    this.mic?.setNoiseNode(null);
    this.noise?.destroy();
    this.noise = null;
  }

  /* ---------------- estado local ---------------- */

  /** Mute/deafen mudaram: aplica localmente e avisa a sala. */
  pushState(): void {
    const v = this.store;
    this.applyOutput();
    this.updateGate();
    // Só ouvindo conta como microfone silenciado para os outros.
    if (v.channelId && v.status === 'connected') this.send({ op: 'voice_state', selfMute: v.micMuted || v.listenOnly, selfDeaf: v.deafened });
  }

  setUserVolume(userId: string, volume: number): void {
    this.playback?.setUserVolume(userId, volume);
    const s = useSettings.getState();
    s.update({ userVolumes: { ...s.settings.userVolumes, [userId]: volume } });
  }

  private applyOutput() {
    const s = useSettings.getState().settings;
    this.playback?.setOutput(s.outputVolume, this.store.deafened);
  }

  private updateGate() {
    if (!this.mic) return;
    const v = this.store;
    const s = useSettings.getState().settings;
    const self = v.channelId ? v.rooms[v.channelId]?.[this.selfId] : undefined;
    const level = this.mic.level();
    this.gateState = gate(this.gateState, {
      now: performance.now(),
      levelDb: level,
      thresholdDb: s.vadThresholdDb,
      mode: s.inputMode,
      pttHeld: v.pttHeld,
      muted: v.micMuted || v.listenOnly,
      deafened: v.deafened,
      suppressed: !!self?.suppressed,
    });
    this.mic.setTransmit(this.gateState.open);
    const speakingSelf = this.gateState.open && level > s.vadThresholdDb;
    if (v.transmitting !== this.gateState.open || v.speaking[this.selfId] !== speakingSelf) {
      v.patch({ transmitting: this.gateState.open, speaking: { ...v.speaking, [this.selfId]: speakingSelf } });
    }
  }

  private startLoops() {
    this.stopLoops();
    // Portão a 50 Hz: abre rápido o bastante para não cortar o começo da fala.
    this.timers.push(setInterval(() => this.updateGate(), 20));
    // Quem está falando (outros), 10 Hz: suficiente para o indicador e barato.
    this.timers.push(
      setInterval(() => {
        if (!this.playback) return;
        const threshold = useSettings.getState().settings.vadThresholdDb + SPEAKING_DB_MARGIN;
        const levels = this.playback.levels();
        const v = this.store;
        const next: Record<string, boolean> = { [this.selfId]: !!v.speaking[this.selfId] };
        for (const [id, db] of Object.entries(levels)) next[id] = db > Math.max(-60, threshold);
        if (JSON.stringify(next) !== JSON.stringify(v.speaking)) v.patch({ speaking: next });
      }, 100),
    );
    // Estatísticas e adaptação de bitrate a cada 2 s; também detecta microfone desconectado.
    this.timers.push(
      setInterval(() => {
        void this.collectStats();
        if (this.mic?.ended) void this.reopenMic('O microfone foi desconectado; usando o padrão do sistema.');
      }, 2000),
    );
    const onKey = (down: boolean) => (ev: KeyboardEvent) => {
      const s = useSettings.getState().settings;
      if (s.inputMode !== 'push_to_talk' || ev.code !== s.pushToTalkKey || ev.repeat) return;
      const t = ev.target as HTMLElement | null;
      if (down && t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (useVoice.getState().pttHeld !== down) useVoice.getState().patch({ pttHeld: down });
    };
    const kd = onKey(true), ku = onKey(false);
    const panicKey = (ev: KeyboardEvent) => {
      if (ev.code === 'F12' && ev.ctrlKey && ev.shiftKey) {
        ev.preventDefault();
        this.panic();
      }
    };
    window.addEventListener('keydown', panicKey, { capture: true });
    this.unsubs.push(() => window.removeEventListener('keydown', panicKey, { capture: true }));
    const blur = () => useVoice.getState().patch({ pttHeld: false });
    const devices = () => void this.checkDevices();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    navigator.mediaDevices?.addEventListener?.('devicechange', devices);
    this.unsubs.push(() => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      navigator.mediaDevices?.removeEventListener?.('devicechange', devices);
    });
    // Mudanças de configuração durante a chamada (volume, dispositivos) valem na hora.
    this.unsubs.push(
      useSettings.subscribe((s, prev) => {
        const a = s.settings, b = prev.settings;
        if (a.inputVolume !== b.inputVolume) this.mic?.setVolume(a.inputVolume);
        if (a.outputVolume !== b.outputVolume) this.applyOutput();
        if (a.outputDeviceId !== b.outputDeviceId && this.ctx) void setContextSink(this.ctx, a.outputDeviceId);
        if (a.noiseMode !== b.noiseMode) {
          // Escolha explícita da pessoa desfaz um fallback automático para Economia.
          const wasEconomy = this.effectiveNoiseMode() === 'economy';
          this.noiseFallback = false;
          const isEconomy = a.noiseMode === 'economy';
          // Ligar/desligar a supressão clássica muda a captura; os demais modos trocam só o nó.
          if (wasEconomy !== isEconomy) void this.reopenMic();
          else void this.applyNoise();
        }
        if (a.inputDeviceId !== b.inputDeviceId || a.echoCancellation !== b.echoCancellation || a.autoGainControl !== b.autoGainControl) {
          void this.reopenMic();
        }
      }),
    );
  }

  private stopLoops() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private async collectStats() {
    if (!this.mesh) return;
    const peers = await this.mesh.stats();
    this.store.patch({ peers });
    await this.collectVideoStats();
    // Adapta pelo pior enlace: em malha, o mesmo áudio vai para todos.
    const samples = Object.values(peers).filter((p) => p.loss != null);
    if (!samples.length) return;
    const worst = {
      loss: Math.max(...samples.map((p) => p.loss ?? 0)),
      jitterMs: Math.max(...samples.map((p) => p.jitterMs ?? 0)),
      rttMs: Math.max(...samples.map((p) => p.rttMs ?? 0)),
    };
    this.adaptState = adapt(this.adaptState, worst);
    await this.mesh.setMaxBitrate(BITRATE_STEPS[this.adaptState.step]!);
  }

  /** Troca o microfone em uso sem sair da sala (replaceTrack, sem renegociar). */
  private async reopenMic(notice?: string) {
    if (!this.ctx || !this.mic) return;
    try {
      const next = await MicPipeline.open(this.ctx, this.micOptions());
      const old = this.mic;
      this.mic = next;
      await this.mesh?.replaceTrack(next.track);
      old.stop();
      this.store.patch({ listenOnly: false });
      // O mesmo nó de supressão (com o estado da rede neural) passa para o microfone novo.
      await this.applyNoise();
      if (notice || next.fellBackToDefault) this.store.patch({ notice: notice ?? 'O microfone escolhido não está disponível; usando o padrão do sistema.' });
    } catch (err) {
      this.store.patch({ notice: err instanceof MicError ? err.message : 'Falha ao trocar de microfone.' });
    }
  }

  private async checkDevices() {
    if (!this.mic) return;
    const { inputs } = await listDevices();
    const current = this.mic.deviceId;
    if (current && !inputs.some((d) => d.deviceId === current)) await this.reopenMic('O microfone foi desconectado; usando o padrão do sistema.');
  }

  private endRinging() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    this.store.patch({ outgoingCall: null });
  }

  private clearRing() {
    this.stopRing?.();
    this.stopRing = null;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
  }

  private fail(message: string) {
    this.teardown(false);
    this.store.patch({ status: 'error', error: message, channelId: null });
  }

  private teardown(sound: boolean) {
    const wasConnected = this.store.status === 'connected';
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.endRinging();
    this.stopLoops();
    this.dropNoise();
    this.capture?.stream.getTracks().forEach((t) => t.stop());
    this.capture = null;
    this.videoAdapt.clear();
    this.cam?.stream.getTracks().forEach((t) => t.stop());
    this.cam = null;
    void this.playSink?.disarm();
    this.playSink = null;
    this.playGuard = null;
    this.playGrantKey = null;
    this.store.patch({ screen: null, screenSend: {}, remoteMedia: {}, mediaRecv: {}, focusedStream: null, camera: null, cameraSend: {}, playRequests: [], playPending: null, playControlling: null, playHost: null });
    this.mesh?.closeAll();
    this.mesh = null;
    this.playback?.close();
    this.playback = null;
    this.mic?.stop();
    this.mic = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gateState = { open: false, lastVoiceAt: 0 };
    this.adaptState = initialAdapt();
    this.store.patch({ channelId: null, status: 'idle', peers: {}, speaking: {}, transmitting: false, pttHeld: false, listenOnly: false, noise: null });
    if (sound && wasConnected) playLeave();
  }
}

export const voice = new VoiceController();

// App para Windows: o atalho global Ctrl+Shift+F12 (registrado no núcleo) já desarmou a injeção;
// aqui revogamos a autorização no servidor e paramos qualquer controle nosso.
if (isTauri()) void listen('play-panic', () => voice.panic()).catch(() => {});

// Mute/deafen pela barra do usuário valem também durante a chamada, com som de confirmação.
useVoice.subscribe((s, prev) => {
  if (s.micMuted === prev.micMuted && s.deafened === prev.deafened) return;
  if (s.channelId) (s.micMuted ? playMute : playUnmute)();
  voice.pushState();
});
