import { Denoiser, type RnnoiseModule } from '../rnnoise';
import { SuppressorCore, type NoiseMode } from '../suppressor';
import { align, findLag, segmentMetrics, siSdr } from './metrics';
import { SR, mix, synthNoise, synthSpeech, type NoiseKind } from './signals';

export interface BenchCase {
  noise: NoiseKind;
  snrDb: number;
}

export interface BenchRow extends BenchCase {
  mode: NoiseMode;
  siSdrIn: number;
  siSdrOut: number;
  siSdrDelta: number;
  noiseReductionDb: number;
  speechLevelChangeDb: number;
  wordCutPct: number;
  latencyMs: number;
}

export const DEFAULT_CASES: BenchCase[] = (['white', 'pink', 'fan', 'keyboard', 'babble'] as NoiseKind[]).flatMap((noise) =>
  [0, 10, 20].map((snrDb) => ({ noise, snrDb })),
);

export const BENCH_MODES: NoiseMode[] = ['off', 'natural', 'light', 'balanced', 'strong', 'auto'];

/** Processa um sinal inteiro com o mesmo núcleo do app, em blocos de 128 (como o AudioWorklet). */
export function processSignal(mod: RnnoiseModule | null, mode: NoiseMode, input: Float32Array): { out: Float32Array; latency: number } {
  const denoiser = mod ? new Denoiser(mod) : null;
  const core = new SuppressorCore(denoiser);
  core.setMode(mode);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128) {
    const end = Math.min(input.length, i + 128);
    core.process(input.subarray(i, end), out.subarray(i, end));
  }
  denoiser?.destroy();
  return { out, latency: core.latencySamples };
}

/**
 * Roda a matriz ruído × SNR × modo. Mesmo ruído e mesma fala (semente fixa) para todos os
 * modos: a única diferença entre linhas é o processamento.
 */
export function runBench(mod: RnnoiseModule, cases = DEFAULT_CASES, seconds = 8, modes = BENCH_MODES): BenchRow[] {
  const rows: BenchRow[] = [];
  const speech = synthSpeech(seconds, 42);
  for (const c of cases) {
    const noise = synthNoise(c.noise, speech.audio.length, 1000 + c.snrDb);
    const { noisy, clean } = mix(speech, noise, c.snrDb);
    const siIn = siSdr(clean, noisy);
    for (const mode of modes) {
      const { out } = processSignal(mod, mode, noisy);
      // Atraso real medido (não o declarado): se mudar, as métricas acusam.
      const lag = findLag(clean, out);
      const aligned = align(out, lag);
      const seg = segmentMetrics(clean, speech.active, noisy, aligned);
      const siOut = siSdr(clean, aligned);
      rows.push({
        ...c,
        mode,
        siSdrIn: round(siIn),
        siSdrOut: round(siOut),
        siSdrDelta: round(siOut - siIn),
        noiseReductionDb: round(seg.noiseReductionDb),
        speechLevelChangeDb: round(seg.speechLevelChangeDb),
        wordCutPct: round(seg.wordCutPct),
        latencyMs: round((lag / SR) * 1000),
      });
    }
  }
  return rows;
}

/** Custo real do processamento: µs por quadro de 10 ms e fração de tempo real. */
export function measureCost(mod: RnnoiseModule, mode: NoiseMode = 'balanced', seconds = 10) {
  const sig = synthNoise('pink', seconds * SR, 7);
  const t0 = performance.now();
  processSignal(mod, mode, sig);
  const ms = performance.now() - t0;
  const frames = (seconds * SR) / 480;
  return { usPerFrame: round((ms / frames) * 1000), realtimePct: round((ms / (seconds * 1000)) * 100, 2) };
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
