/**
 * AudioWorklet de supressão de ruído. Roda na thread de áudio: a interface nunca trava o
 * processamento, e o processamento nunca trava a interface.
 */
import { Denoiser, instantiateRnnoise } from './rnnoise';
import { SuppressorCore, type NoiseMode } from './suppressor';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export type WorkletMessage =
  | { type: 'ready'; latencySamples: number }
  | { type: 'error'; message: string }
  | ({ type: 'stats'; loadPct: number } & ReturnType<SuppressorCore['stats']>);

const STATS_EVERY_FRAMES = 24_000; // 0,5 s a 48 kHz

class NexoNoiseProcessor extends AudioWorkletProcessor {
  private core: SuppressorCore | null = null;
  private denoiser: Denoiser | null = null;
  private mode: NoiseMode;
  private alive = true;
  private busyMs = 0;
  private audioMs = 0;
  private lastStats = 0;

  constructor(options: { processorOptions: { wasm: ArrayBuffer; mode: NoiseMode } }) {
    super(options);
    this.mode = options.processorOptions.mode;
    if (sampleRate !== 48_000) this.port.postMessage({ type: 'error', message: `taxa de amostragem ${sampleRate} Hz; o RNNoise exige 48 kHz` });
    instantiateRnnoise(options.processorOptions.wasm).then(
      (mod) => {
        if (!this.alive) return;
        this.denoiser = new Denoiser(mod);
        this.core = new SuppressorCore(this.denoiser);
        this.core.setMode(this.mode);
        this.port.postMessage({ type: 'ready', latencySamples: this.core.latencySamples } satisfies WorkletMessage);
      },
      (err: unknown) => this.port.postMessage({ type: 'error', message: String(err) } satisfies WorkletMessage),
    );
    this.port.onmessage = (e: MessageEvent<{ type: 'mode'; mode: NoiseMode } | { type: 'destroy' }>) => {
      if (e.data.type === 'mode') {
        this.mode = e.data.mode;
        this.core?.setMode(e.data.mode);
      } else if (e.data.type === 'destroy') {
        this.alive = false;
        this.denoiser?.destroy();
        this.core = null;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return this.alive;
    const input = inputs[0]?.[0];
    if (!input) {
      out.fill(0);
      return this.alive;
    }
    if (!this.core) {
      out.set(input); // enquanto o modelo carrega, o áudio passa direto (sem buraco na voz)
      return this.alive;
    }
    // Date.now tem resolução de 1 ms (o worklet não tem performance.now): mede bem justamente a
    // situação que importa — quando processar um bloco de 2,7 ms passa a custar milissegundos.
    const t0 = Date.now();
    this.core.process(input, out);
    this.busyMs += Date.now() - t0;
    this.audioMs += (input.length / sampleRate) * 1000;
    if (currentFrame - this.lastStats >= STATS_EVERY_FRAMES) {
      this.lastStats = currentFrame;
      this.port.postMessage({ type: 'stats', loadPct: Math.round((this.busyMs / this.audioMs) * 100), ...this.core.stats() } satisfies WorkletMessage);
      this.busyMs = this.audioMs = 0;
    }
    return this.alive;
  }
}

registerProcessor('nexo-noise', NexoNoiseProcessor);
