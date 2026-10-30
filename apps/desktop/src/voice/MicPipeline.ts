import { rmsDb } from './gate';

export interface MicOptions {
  deviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  inputVolume: number;
}

export const micOptionsFrom = (s: {
  inputDeviceId: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
  inputVolume: number;
  noiseMode: string;
}): MicOptions => ({
  deviceId: s.inputDeviceId,
  echoCancellation: s.echoCancellation,
  // A supressão clássica do WebRTC só no modo Economia: com a neural ativa, as duas juntas
  // processariam o mesmo ruído duas vezes (mais distorção, nenhum ganho).
  noiseSuppression: s.noiseMode === 'economy',
  autoGainControl: s.autoGainControl,
  inputVolume: s.inputVolume,
});

export class MicError extends Error {
  constructor(
    readonly kind: 'denied' | 'not_found' | 'busy' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

function describeGumError(err: unknown): MicError {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return new MicError('denied', 'O acesso ao microfone foi negado. Libere nas permissões do sistema/navegador.');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new MicError('not_found', 'Nenhum microfone encontrado. Conecte um e tente de novo.');
  if (name === 'NotReadableError' || name === 'AbortError') return new MicError('busy', 'O microfone está em uso por outro programa ou falhou ao iniciar.');
  return new MicError('unknown', 'Não foi possível abrir o microfone.');
}

/**
 * Cadeia de captura:
 *   microfone (getUserMedia: cancelamento de eco e ganho automático do WebRTC, aplicados na captura)
 *     → supressão de ruído neural (opcional, AudioWorklet)
 *     → ganho de entrada → limitador de picos → analisador (nível/ativação por voz)
 *     → saída enviada aos participantes (Opus).
 * O eco é removido antes da supressão (o RNNoise não distingue eco de voz); o limitador fica no
 * fim para que nenhum ajuste anterior produza clipping. A faixa enviada é a da saída do grafo;
 * `setTransmit(false)` a desliga na origem: nada capturado sai enquanto o microfone está fechado.
 */
export class MicPipeline {
  private readonly raw: MediaStream;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly gain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private noiseNode: AudioNode | null = null;
  private readonly analyser: AnalyserNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  /** Dispositivo realmente em uso (pode diferir do pedido se ele sumiu). */
  readonly deviceLabel: string;
  readonly fellBackToDefault: boolean;

  private constructor(
    readonly ctx: AudioContext,
    raw: MediaStream,
    opts: MicOptions,
    fellBack: boolean,
  ) {
    this.raw = raw;
    this.fellBackToDefault = fellBack;
    this.deviceLabel = raw.getAudioTracks()[0]?.label ?? '';
    this.source = ctx.createMediaStreamSource(raw);
    this.gain = ctx.createGain();
    this.gain.gain.value = opts.inputVolume;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.dest = ctx.createMediaStreamDestination();
    this.buf = new Float32Array(this.analyser.fftSize);
    // Limitador: compressão 20:1 instantânea acima de -2 dBFS — só segura picos (gritos, estalos).
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    this.source.connect(this.gain).connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.limiter.connect(this.dest);
    this.setTransmit(false);
  }

  static async open(ctx: AudioContext, opts: MicOptions): Promise<MicPipeline> {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unknown', 'Este ambiente não permite captura de áudio.');
    const constraints = (deviceId?: string): MediaStreamConstraints => ({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: opts.echoCancellation,
        noiseSuppression: opts.noiseSuppression,
        autoGainControl: opts.autoGainControl,
        channelCount: 1,
        sampleRate: 48_000,
      },
      video: false,
    });
    const wanted = opts.deviceId && opts.deviceId !== 'default' ? opts.deviceId : undefined;
    try {
      return new MicPipeline(ctx, await navigator.mediaDevices.getUserMedia(constraints(wanted)), opts, false);
    } catch (err) {
      // Dispositivo escolhido sumiu (headset desconectado): cai para o padrão do sistema.
      if (wanted && ((err as DOMException).name === 'OverconstrainedError' || (err as DOMException).name === 'NotFoundError')) {
        try {
          return new MicPipeline(ctx, await navigator.mediaDevices.getUserMedia(constraints()), opts, true);
        } catch (e2) {
          throw describeGumError(e2);
        }
      }
      throw describeGumError(err);
    }
  }

  /**
   * Pipeline sem captura: uma faixa de silêncio digital, para entrar numa sala só ouvindo
   * (sem microfone ou com acesso negado). Nenhum dispositivo é aberto.
   */
  static silent(ctx: AudioContext): MicPipeline {
    const empty = ctx.createMediaStreamDestination().stream;
    const p = new MicPipeline(ctx, empty, { deviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false, inputVolume: 0 }, false);
    p.listenOnly = true;
    return p;
  }

  listenOnly = false;

  /** Faixa processada que vai para os participantes. */
  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0]!;
  }

  /** Id do dispositivo de captura em uso. */
  get deviceId(): string | undefined {
    return this.raw.getAudioTracks()[0]?.getSettings().deviceId;
  }

  /** O microfone físico foi desconectado/encerrado pelo sistema. */
  get ended(): boolean {
    return !this.listenOnly && this.raw.getAudioTracks()[0]?.readyState === 'ended';
  }

  setVolume(v: number): void {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Nível atual em dBFS, depois do ganho de entrada. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    return rmsDb(this.buf);
  }

  setTransmit(on: boolean): void {
    const t = this.track;
    if (t.enabled !== on) t.enabled = on;
  }

  /** Para monitorar a própria voz (já processada) no teste de microfone. */
  connectMonitor(node: AudioNode): () => void {
    this.limiter.connect(node);
    return () => this.limiter.disconnect(node);
  }

  /**
   * Insere (ou remove, com null) o nó de supressão entre a captura e o ganho.
   * Sem supressão o nó sai da cadeia: nenhuma latência é adicionada.
   */
  setNoiseNode(node: AudioNode | null): void {
    if (node === this.noiseNode) return;
    this.source.disconnect();
    this.noiseNode?.disconnect();
    this.noiseNode = node;
    if (node) this.source.connect(node).connect(this.gain);
    else this.source.connect(this.gain);
  }

  /** Captura crua (antes de qualquer processamento do app) — usada na comparação A/B. */
  get rawStream(): MediaStream {
    return this.raw;
  }

  stop(): void {
    this.setTransmit(false);
    for (const t of this.raw.getTracks()) t.stop();
    this.source.disconnect();
    this.noiseNode?.disconnect();
    this.gain.disconnect();
    this.limiter.disconnect();
    this.analyser.disconnect();
  }
}

export async function listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  return { inputs: all.filter((d) => d.kind === 'audioinput'), outputs: all.filter((d) => d.kind === 'audiooutput') };
}

/** AudioContext com troca de saída (Chrome/WebView2 110+). */
export async function setContextSink(ctx: AudioContext, deviceId: string): Promise<boolean> {
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!c.setSinkId) return false;
  try {
    await c.setSinkId(deviceId === 'default' ? '' : deviceId);
    return true;
  } catch {
    return false;
  }
}
