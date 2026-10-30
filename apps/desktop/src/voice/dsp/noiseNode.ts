import rnnoiseUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import workletUrl from './noise.worklet.ts?worker&url';
import { Denoiser, instantiateRnnoise, supportsWasmSimd } from './rnnoise';
import type { NoiseMode } from './suppressor';
import type { WorkletMessage } from './noise.worklet';

export type NoiseStats = Extract<WorkletMessage, { type: 'stats' }>;

let wasmBytes: Promise<ArrayBuffer> | null = null;
const loadedIn = new WeakMap<BaseAudioContext, Promise<void>>();

/** Baixa (uma vez) o binário do RNNoise — versão SIMD quando o motor suporta. */
export function loadRnnoiseBinary(): Promise<ArrayBuffer> {
  wasmBytes ??= fetch(supportsWasmSimd() ? rnnoiseSimdUrl : rnnoiseUrl).then((r) => {
    if (!r.ok) throw new Error(`falha ao carregar o modelo de ruído (${r.status})`);
    return r.arrayBuffer();
  });
  return wasmBytes;
}

/** Nó de supressão de ruído para um contexto de áudio (em tempo real ou offline). */
export class NoiseNode {
  readonly node: AudioWorkletNode;
  private statsListeners = new Set<(s: NoiseStats) => void>();
  readonly ready: Promise<number>;

  private constructor(ctx: BaseAudioContext, wasm: ArrayBuffer, mode: NoiseMode) {
    this.node = new AudioWorkletNode(ctx, 'nexo-noise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { wasm, mode },
    });
    this.ready = new Promise((resolve, reject) => {
      this.node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
        const m = e.data;
        if (m.type === 'ready') resolve(m.latencySamples);
        else if (m.type === 'error') reject(new Error(m.message));
        else for (const fn of this.statsListeners) fn(m);
      };
    });
  }

  static async create(ctx: BaseAudioContext, mode: NoiseMode): Promise<NoiseNode> {
    const wasm = await loadRnnoiseBinary();
    let loaded = loadedIn.get(ctx);
    if (!loaded) loadedIn.set(ctx, (loaded = ctx.audioWorklet.addModule(workletUrl)));
    await loaded;
    // Cada nó recebe sua própria cópia do binário (é transferido para a thread de áudio).
    const node = new NoiseNode(ctx, wasm.slice(0), mode);
    await node.ready;
    return node;
  }

  setMode(mode: NoiseMode): void {
    this.node.port.postMessage({ type: 'mode', mode });
  }

  onStats(fn: (s: NoiseStats) => void): () => void {
    this.statsListeners.add(fn);
    return () => this.statsListeners.delete(fn);
  }

  destroy(): void {
    this.node.port.postMessage({ type: 'destroy' });
    this.node.disconnect();
    this.statsListeners.clear();
  }
}

let calibration: Promise<number> | null = null;

/**
 * Mede, uma vez por sessão, quanto custa processar 10 ms de áudio neste computador (em µs),
 * rodando o mesmo modelo no thread principal por ~100 quadros. Serve para decidir se o modo
 * neural é viável aqui e para mostrar o custo real nas configurações.
 */
export function measureNeuralCostUs(): Promise<number> {
  calibration ??= (async () => {
    const mod = await instantiateRnnoise(await loadRnnoiseBinary());
    const d = new Denoiser(mod);
    const x = new Float32Array(d.frameSize);
    const y = new Float32Array(d.frameSize);
    for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * 0.05;
    for (let i = 0; i < 10; i++) d.process(x, y); // aquecimento
    const t0 = performance.now();
    const N = 100;
    for (let i = 0; i < N; i++) d.process(x, y);
    const us = ((performance.now() - t0) / N) * 1000;
    d.destroy();
    return Math.round(us);
  })();
  return calibration;
}
