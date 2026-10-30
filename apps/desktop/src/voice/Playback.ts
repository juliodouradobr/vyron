import { rmsDb } from './gate';

interface RemoteNode {
  el: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  volume: number;
  suppressed: boolean;
}

/**
 * Reprodução das vozes recebidas: cada pessoa tem seu ganho (volume individual até 200%)
 * e analisador (indicador de quem está falando), todos passando por um ganho mestre
 * (volume de saída; ensurdecer = 0).
 */
export class Playback {
  private readonly master: GainNode;
  private readonly nodes = new Map<string, RemoteNode>();
  private readonly buf = new Float32Array(512);

  constructor(private readonly ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  add(userId: string, stream: MediaStream, volume: number, suppressed: boolean): void {
    this.remove(userId);
    // O Chromium só entrega áudio WebRTC ao Web Audio se a stream também estiver num elemento de mídia.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    void el.play().catch(() => {});
    const source = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    source.connect(gain).connect(this.master);
    const node = { el, source, gain, analyser, volume, suppressed };
    this.nodes.set(userId, node);
    this.apply(node);
  }

  remove(userId: string): void {
    const n = this.nodes.get(userId);
    if (!n) return;
    n.source.disconnect();
    n.gain.disconnect();
    n.el.srcObject = null;
    this.nodes.delete(userId);
  }

  setUserVolume(userId: string, volume: number): void {
    const n = this.nodes.get(userId);
    if (n) {
      n.volume = volume;
      this.apply(n);
    }
  }

  /** Quem não tem permissão de falar não é reproduzido, mesmo que o cliente dele envie áudio. */
  setSuppressed(userId: string, suppressed: boolean): void {
    const n = this.nodes.get(userId);
    if (n) {
      n.suppressed = suppressed;
      this.apply(n);
    }
  }

  setOutput(volume: number, deafened: boolean): void {
    this.master.gain.setTargetAtTime(deafened ? 0 : volume, this.ctx.currentTime, 0.02);
  }

  /** Nível de cada pessoa (dBFS) — antes do volume individual, para o indicador não depender dele. */
  levels(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.nodes) {
      if (n.suppressed) continue;
      n.analyser.getFloatTimeDomainData(this.buf);
      out[id] = rmsDb(this.buf);
    }
    return out;
  }

  has(userId: string): boolean {
    return this.nodes.has(userId);
  }

  close(): void {
    for (const id of [...this.nodes.keys()]) this.remove(id);
    this.master.disconnect();
  }

  private apply(n: RemoteNode) {
    n.gain.gain.setTargetAtTime(n.suppressed ? 0 : n.volume, this.ctx.currentTime, 0.02);
  }
}
