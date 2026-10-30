// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import baseline from './bench/baseline.json';
import { processSignal, runBench, type BenchCase } from './bench/run';
import { SR, synthNoise } from './bench/signals';
import { Denoiser, instantiateRnnoise, type RnnoiseModule } from './rnnoise';
import { SuppressorCore, type NoiseMode } from './suppressor';

const here = path.dirname(fileURLToPath(import.meta.url));
let mod: RnnoiseModule;
beforeAll(async () => {
  mod = await instantiateRnnoise(await readFile(path.resolve(here, '../../../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm')));
});

describe('núcleo de supressão', () => {
  it('Desativado é a entrada pura, só atrasada pela latência declarada (20 ms)', () => {
    const x = synthNoise('pink', SR, 3).map((v) => v * 0.1);
    const { out, latency } = processSignal(mod, 'off', x);
    expect(latency).toBe(960);
    for (let i = latency; i < x.length; i += 97) expect(out[i]).toBeCloseTo(x[i - latency]!, 6);
  });

  it('nenhum modo produz NaN, infinito ou saturação, e trocar de modo no meio não estoura', () => {
    const x = synthNoise('keyboard', SR * 2, 4);
    const core = new SuppressorCore(new Denoiser(mod));
    const out = new Float32Array(128);
    const modes: NoiseMode[] = ['strong', 'natural', 'auto', 'off', 'light', 'balanced'];
    let bad = 0;
    let peak = 0;
    for (let i = 0, k = 0; i + 128 <= x.length; i += 128, k++) {
      if (k % 60 === 0) core.setMode(modes[(k / 60) % modes.length]!);
      core.process(x.subarray(i, i + 128), out);
      for (const v of out) {
        if (!Number.isFinite(v)) bad++;
        else peak = Math.max(peak, Math.abs(v));
      }
    }
    expect(bad).toBe(0);
    expect(peak).toBeLessThan(1.5);
  });

  it('aceita blocos de tamanhos irregulares sem perder ou duplicar amostras', () => {
    const x = synthNoise('white', SR, 5).map((v) => v * 0.05);
    const core = new SuppressorCore(null);
    core.setMode('off');
    const out = new Float32Array(x.length);
    let i = 0;
    for (const size of [1, 7, 128, 479, 480, 481, 1000]) {
      for (let r = 0; r < 20 && i + size <= x.length; r++, i += size) core.process(x.subarray(i, i + size), out.subarray(i, i + size));
    }
    for (let j = 960; j < i; j += 53) expect(out[j]).toBeCloseTo(x[j - 960]!, 6);
  });

  it('o portão do modo Forte não cria degraus (cliques) entre quadros', () => {
    const x = synthNoise('pink', SR * 2, 6).map((v) => v * 0.02);
    const { out } = processSignal(mod, 'strong', x);
    let maxJump = 0;
    for (let i = SR; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i]! - out[i - 1]!));
    expect(maxJump).toBeLessThan(0.05);
  });
});

/**
 * Regressão: um subconjunto da bancada (mesma fala e ruídos, sementes fixas) não pode piorar
 * em relação à linha de base gravada. Melhorar a redução às custas de cortar palavras falha aqui.
 * Atualizar a base: `npm run bench:noise -w @nexo/desktop -- --baseline` (e revisar o diff).
 */
describe('regressão da bancada de ruído', () => {
  const cases: BenchCase[] = [
    { noise: 'pink', snrDb: 0 },
    { noise: 'keyboard', snrDb: 10 },
    { noise: 'fan', snrDb: 20 },
  ];
  it(
    'Δ SI-SDR, redução de ruído e cortes de palavra dentro da tolerância da linha de base',
    () => {
      const rows = runBench(mod, cases);
      for (const r of rows) {
        const b = baseline.find((x) => x.noise === r.noise && x.snrDb === r.snrDb && x.mode === r.mode);
        expect(b, `${r.noise}/${r.snrDb}/${r.mode} sem linha de base`).toBeDefined();
        const ctx = `${r.noise} ${r.snrDb} dB ${r.mode}`;
        expect(r.siSdrDelta, `${ctx}: SI-SDR piorou`).toBeGreaterThanOrEqual(b!.siSdrDelta - 0.5);
        expect(r.wordCutPct, `${ctx}: mais palavras cortadas`).toBeLessThanOrEqual(b!.wordCutPct + 2);
        expect(r.noiseReductionDb, `${ctx}: menos ruído removido`).toBeGreaterThanOrEqual(b!.noiseReductionDb - 1);
      }
    },
    120_000,
  );
});
