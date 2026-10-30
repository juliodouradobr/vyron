/**
 * Bancada de supressão de ruído (Node). Uso:
 *   npm run bench:noise -w @nexo/desktop            → imprime a tabela e grava docs/NOISE_BENCHMARK.md
 *   npm run bench:noise -w @nexo/desktop -- --baseline → também atualiza a linha de base da regressão
 *
 * Todos os números são medidos nesta execução, nesta máquina. Nada é estimado.
 */
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateRnnoise } from '../src/voice/dsp/rnnoise';
import { measureCost, runBench, type BenchRow } from '../src/voice/dsp/bench/run';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const wasmDir = path.join(root, 'node_modules/@sapphi-red/web-noise-suppressor/dist');

const simd = await instantiateRnnoise(await readFile(path.join(wasmDir, 'rnnoise_simd.wasm')));
const scalar = await instantiateRnnoise(await readFile(path.join(wasmDir, 'rnnoise.wasm')));

const t0 = performance.now();
const rows = runBench(simd);
const benchSecs = ((performance.now() - t0) / 1000).toFixed(1);
const costSimd = measureCost(simd);
const costScalar = measureCost(scalar);
const costStrong = measureCost(simd, 'strong');

const MODE_LABEL: Record<string, string> = {
  off: 'Desativado',
  natural: 'Natural',
  light: 'Leve',
  balanced: 'Equilibrado',
  strong: 'Forte',
  auto: 'Automático',
};

function table(list: BenchRow[]) {
  const head = '| Ruído | SNR | Modo | SI-SDR entrada | SI-SDR saída | Δ SI-SDR | Redução nas pausas | Nível da fala | Cortes de palavra | Latência |\n|---|---|---|---|---|---|---|---|---|---|';
  return [
    head,
    ...list.map(
      (r) =>
        `| ${r.noise} | ${r.snrDb} dB | ${MODE_LABEL[r.mode]} | ${r.siSdrIn} | ${r.siSdrOut} | ${r.siSdrDelta > 0 ? '+' : ''}${r.siSdrDelta} | ${r.noiseReductionDb} dB | ${r.speechLevelChangeDb} dB | ${r.wordCutPct}% | ${r.latencyMs} ms |`,
    ),
  ].join('\n');
}

function summary(list: BenchRow[]) {
  const modes = [...new Set(list.map((r) => r.mode))];
  const lines = modes.map((m) => {
    const rs = list.filter((r) => r.mode === m);
    const avg = (k: keyof BenchRow) => (rs.reduce((s, r) => s + (r[k] as number), 0) / rs.length).toFixed(1);
    return `| ${MODE_LABEL[m]} | ${avg('siSdrDelta')} dB | ${avg('noiseReductionDb')} dB | ${avg('speechLevelChangeDb')} dB | ${avg('wordCutPct')}% |`;
  });
  return ['| Modo | Δ SI-SDR médio | Redução média nas pausas | Nível médio da fala | Cortes médios |', '|---|---|---|---|---|', ...lines].join('\n');
}

const cpu = os.cpus()[0]?.model ?? 'desconhecida';
const md = `# Bancada de supressão de ruído

Gerado por \`npm run bench:noise -w @nexo/desktop\` em ${new Date().toISOString().slice(0, 10)}.
Máquina: ${cpu} · Node ${process.version} · ${os.platform()} ${os.release()}. Execução: ${benchSecs} s.

> **Limitação importante:** a fala é **sintética** (formantes), não gravações reais. O RNNoise foi
> treinado com fala real, então os números indicam o comportamento da cadeia e servem para
> detectar regressões — não são uma medida de qualidade perceptual. Para isso: o A/B
> "original × processado" nas configurações (com sua própria voz) e, no futuro, bases reais
> (ex.: VCTK + DEMAND, CC BY 4.0) e avaliação com ouvintes.

## Custo de processamento (medido)

| Variante | µs por quadro de 10 ms | % de um núcleo |
|---|---|---|
| RNNoise SIMD — Equilibrado | ${costSimd.usPerFrame} | ${costSimd.realtimePct}% |
| RNNoise SIMD — Forte (com portão) | ${costStrong.usPerFrame} | ${costStrong.realtimePct}% |
| RNNoise sem SIMD — Equilibrado | ${costScalar.usPerFrame} | ${costScalar.realtimePct}% |

Latência adicionada pelos modos neurais (medida por correlação): ${rows.find((r) => r.mode === 'balanced')?.latencyMs} ms.
Desativado/Economia: o nó sai da cadeia (0 ms adicionais).

## Resumo por modo (média de ${new Set(rows.map((r) => r.noise + r.snrDb)).size} condições)

${summary(rows)}

Leitura: **Δ SI-SDR** maior = saída mais próxima da fala limpa. **Redução nas pausas** = quanto ruído
some quando ninguém fala. **Nível da fala** perto de 0 dB = voz preservada. **Cortes** = % de quadros
de fala que ficaram mais de 10 dB abaixo do original (palavras "comidas").

## Resultados completos

${table(rows)}
`;

await writeFile(path.join(root, 'docs/NOISE_BENCHMARK.md'), md);
console.log(summary(rows));
console.log('\ncusto SIMD', costSimd, 'sem SIMD', costScalar, 'forte', costStrong);
console.log(`bench em ${benchSecs}s → docs/NOISE_BENCHMARK.md`);

if (process.argv.includes('--baseline')) {
  const baseline = rows.map(({ noise, snrDb, mode, siSdrDelta, noiseReductionDb, wordCutPct }) => ({ noise, snrDb, mode, siSdrDelta, noiseReductionDb, wordCutPct }));
  await writeFile(path.join(here, '../src/voice/dsp/bench/baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
  console.log('linha de base atualizada');
}
