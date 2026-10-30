/**
 * Métricas objetivas da bancada. Todas comparam com o sinal limpo conhecido e ignoram o
 * primeiro segundo (tempo de adaptação do modelo).
 */
const SKIP = 48_000;
const FRAME = 480;

/** Desloca `y` para compensar o atraso `lag` (amostras). */
export function align(y: Float32Array, lag: number): Float32Array {
  const out = new Float32Array(y.length);
  out.set(y.subarray(lag));
  return out;
}

/**
 * SI-SDR (Scale-Invariant Signal-to-Distortion Ratio, Le Roux et al. 2019), em dB.
 * Projeta a estimativa na referência: o que sobra fora dela é ruído + distorção.
 * Maior é melhor; a melhoria (saída − entrada) mostra quanto o processamento ajudou.
 */
export function siSdr(ref: Float32Array, est: Float32Array, from = SKIP): number {
  let dot = 0, rr = 0;
  const n = Math.min(ref.length, est.length);
  let mr = 0, me = 0;
  for (let i = from; i < n; i++) {
    mr += ref[i]!;
    me += est[i]!;
  }
  mr /= n - from;
  me /= n - from;
  for (let i = from; i < n; i++) {
    const r = ref[i]! - mr;
    dot += r * (est[i]! - me);
    rr += r * r;
  }
  const a = dot / (rr || 1e-12);
  let ps = 0, pe = 0;
  for (let i = from; i < n; i++) {
    const t = a * (ref[i]! - mr);
    const e = est[i]! - me - t;
    ps += t * t;
    pe += e * e;
  }
  return 10 * Math.log10(ps / (pe || 1e-12));
}

/** Atraso (amostras) que maximiza a correlação entre referência e saída. */
export function findLag(ref: Float32Array, out: Float32Array, maxLag = 2048): number {
  let best = -Infinity, bestLag = 0;
  const end = Math.min(ref.length - maxLag, SKIP + 4 * 48_000);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let c = 0;
    for (let i = SKIP; i < end; i += 2) c += ref[i]! * out[i + lag]!;
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return bestLag;
}

function frameEnergy(x: Float32Array, f: number) {
  let s = 0;
  for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += x[i]! * x[i]!;
  return s / FRAME;
}

export interface SegmentMetrics {
  /** Redução de energia nas pausas (onde só há ruído), em dB. Maior = mais ruído removido. */
  noiseReductionDb: number;
  /** Variação de energia nos trechos de fala (saída vs. entrada ruidosa), em dB. Negativo = fala atenuada. */
  speechLevelChangeDb: number;
  /** % de quadros de fala em que a saída ficou >10 dB abaixo da fala limpa: palavras "comidas". */
  wordCutPct: number;
}

/**
 * Métricas por segmento, usando a máscara de atividade da fala limpa. Quadros de transição
 * (parcialmente ativos) são ignorados para não misturar categorias.
 */
export function segmentMetrics(clean: Float32Array, active: Uint8Array, noisy: Float32Array, out: Float32Array): SegmentMetrics {
  const frames = Math.floor(Math.min(clean.length, out.length) / FRAME);
  let nIn = 0, nOut = 0, sIn = 0, sOut = 0, speechFrames = 0, cut = 0;
  for (let f = Math.ceil(SKIP / FRAME); f < frames; f++) {
    let a = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) a += active[i]!;
    const eIn = frameEnergy(noisy, f);
    const eOut = frameEnergy(out, f);
    if (a === 0) {
      nIn += eIn;
      nOut += eOut;
    } else if (a === FRAME) {
      const eClean = frameEnergy(clean, f);
      // Só conta quadros com fala audível (> -50 dB do pico da frase).
      if (eClean < 1e-6) continue;
      sIn += eIn;
      sOut += eOut;
      speechFrames++;
      if (eOut < eClean * 0.1) cut++;
    }
  }
  const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-20));
  return {
    noiseReductionDb: db(nIn) - db(nOut),
    speechLevelChangeDb: db(sOut) - db(sIn),
    wordCutPct: speechFrames ? (cut / speechFrames) * 100 : 0,
  };
}
