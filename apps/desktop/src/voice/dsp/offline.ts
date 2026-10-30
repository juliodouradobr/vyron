import { loadRnnoiseBinary } from './noiseNode';
import { Denoiser, instantiateRnnoise, type RnnoiseModule } from './rnnoise';
import { SuppressorCore, type NoiseMode, type SuppressorStats } from './suppressor';

let mod: Promise<RnnoiseModule> | null = null;

export interface OfflineResult {
  mode: NoiseMode;
  audio: Float32Array;
  stats: SuppressorStats | null;
}

/**
 * Processa uma gravação inteira com o mesmo núcleo usado na chamada, no thread principal.
 * Rápido o bastante para a comparação A/B (6 s de áudio ≈ 0,2 s de processamento) e
 * determinístico: a mesma gravação, modos diferentes. O atraso de 20 ms é removido para
 * que alternar entre as versões não "pule".
 */
export async function processOffline(input: Float32Array, modes: NoiseMode[]): Promise<OfflineResult[]> {
  mod ??= loadRnnoiseBinary().then(instantiateRnnoise);
  const m = await mod;
  return modes.map((mode) => {
    const denoiser = mode === 'off' ? null : new Denoiser(m);
    const core = new SuppressorCore(denoiser);
    core.setMode(mode);
    const padded = new Float32Array(input.length + core.latencySamples);
    padded.set(input);
    const out = new Float32Array(padded.length);
    for (let i = 0; i < padded.length; i += 128) {
      const end = Math.min(padded.length, i + 128);
      core.process(padded.subarray(i, end), out.subarray(i, end));
    }
    const stats = denoiser ? core.stats() : null;
    denoiser?.destroy();
    return { mode, audio: out.slice(core.latencySamples), stats };
  });
}
