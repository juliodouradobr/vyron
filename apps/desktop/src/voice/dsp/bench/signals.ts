/**
 * Sinais de teste determinísticos (semente fixa) para a bancada de supressão de ruído.
 *
 * A "fala" é sintetizada por formantes: trem de pulsos glotais com f0 variável → três
 * ressonâncias (F1–F3) que deslizam entre vogais, sílabas com envelope, fricativas e pausas.
 * Não é fala real: serve para medir o comportamento da cadeia de forma reprodutível e
 * pegar regressões. Qualidade perceptual exige gravações reais e escuta (ver o A/B no app).
 */
export const SR = 48_000;

/** PRNG mulberry32: determinístico entre execuções e plataformas. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ressonador de dois polos (formante). */
class Resonator {
  private y1 = 0;
  private y2 = 0;
  set(freq: number, bw: number) {
    const r = Math.exp((-Math.PI * bw) / SR);
    this.b1 = 2 * r * Math.cos((2 * Math.PI * freq) / SR);
    this.b2 = -r * r;
    this.g = 1 - r;
  }
  private b1 = 0;
  private b2 = 0;
  private g = 0;
  tick(x: number) {
    const y = this.g * x + this.b1 * this.y1 + this.b2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const VOWELS: Array<[number, number, number]> = [
  [730, 1090, 2440], // a
  [270, 2290, 3010], // i
  [300, 870, 2240], // u
  [530, 1840, 2480], // e
  [570, 840, 2410], // o
];

export interface SpeechSignal {
  audio: Float32Array;
  /** 1 nas amostras com fala, 0 nas pausas — referência para métricas por segmento. */
  active: Uint8Array;
}

export function synthSpeech(seconds: number, seed: number, f0Base = 140): SpeechSignal {
  const r = rng(seed);
  const n = Math.round(seconds * SR);
  const audio = new Float32Array(n);
  const active = new Uint8Array(n);
  const f = [new Resonator(), new Resonator(), new Resonator()];
  let i = Math.round(0.3 * SR); // começa com silêncio
  let phase = 0;
  let vowel = VOWELS[0]!;
  while (i < n) {
    const words = 2 + Math.floor(r() * 4);
    for (let w = 0; w < words && i < n; w++) {
      const syllables = 1 + Math.floor(r() * 3);
      for (let s = 0; s < syllables && i < n; s++) {
        // Consoante fricativa curta em ~40% das sílabas.
        if (r() < 0.4) {
          const len = Math.round((0.04 + r() * 0.05) * SR);
          let lp = 0;
          for (let k = 0; k < len && i < n; k++, i++) {
            const white = r() * 2 - 1;
            const hp = white - lp; // passa-altas simples: chiado de "s"/"f"
            lp += 0.3 * (white - lp);
            audio[i] = hp * 0.05 * Math.sin((Math.PI * k) / len);
            active[i] = 1;
          }
        }
        const target = VOWELS[Math.floor(r() * VOWELS.length)]!;
        const len = Math.round((0.12 + r() * 0.14) * SR);
        const f0Start = f0Base * (0.85 + r() * 0.3);
        const f0End = f0Start * (0.85 + r() * 0.3);
        for (let k = 0; k < len && i < n; k++, i++) {
          const t = k / len;
          // Formantes deslizam da vogal anterior para a nova (coarticulação).
          for (let j = 0; j < 3; j++) f[j]!.set(vowel[j]! + (target[j]! - vowel[j]!) * Math.min(1, t * 3), 60 + 40 * j);
          const f0 = (f0Start + (f0End - f0Start) * t) * (1 + 0.01 * (r() - 0.5)); // leve jitter
          phase += f0 / SR;
          let src = 0;
          if (phase >= 1) {
            phase -= 1;
            src = 1; // pulso glotal
          }
          src += 0.02 * (r() * 2 - 1); // aspiração
          const v = f[0]!.tick(src) * 1.0 + f[1]!.tick(src) * 0.5 + f[2]!.tick(src) * 0.25;
          const env = Math.sin(Math.PI * Math.min(1, t * 1.2)) ** 0.6;
          audio[i] = v * env * 0.9;
          active[i] = 1;
        }
        vowel = target;
      }
      i += Math.round((0.08 + r() * 0.25) * SR); // pausa entre palavras
    }
    i += Math.round((0.3 + r() * 0.5) * SR); // pausa entre frases
  }
  normalizePeak(audio, 0.5);
  return { audio, active };
}

export type NoiseKind = 'white' | 'pink' | 'fan' | 'keyboard' | 'babble';

export function synthNoise(kind: NoiseKind, n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  if (kind === 'white') for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  else if (kind === 'pink') {
    // Filtro de Paul Kellet: ruído rosa (−3 dB/oitava), como chiado de ambiente.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else if (kind === 'fan') {
    // Ventoinha/ar-condicionado: zumbido de 120 Hz com harmônicos + ruído grave de fluxo de ar.
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      lp += 0.02 * (r() * 2 - 1 - lp);
      out[i] = 0.6 * Math.sin(2 * Math.PI * 120 * t) + 0.3 * Math.sin(2 * Math.PI * 240 * t + 1) + 0.15 * Math.sin(2 * Math.PI * 360 * t + 2) + 4 * lp;
    }
  } else if (kind === 'keyboard') {
    // Teclado mecânico: cliques transientes (ataque seco + ressonância curta) em ritmo irregular.
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (i >= next) {
        const len = Math.round(0.012 * SR);
        const amp = 0.6 + r() * 0.4;
        const fr = 2000 + r() * 3000;
        for (let k = 0; k < len && i + k < n; k++) {
          const decay = Math.exp(-k / (0.0025 * SR));
          out[i + k]! += amp * decay * ((r() * 2 - 1) * 0.6 + Math.sin((2 * Math.PI * fr * k) / SR) * 0.4);
        }
        next = i + Math.round((0.06 + r() * 0.2) * SR);
      }
    }
  } else {
    // Burburinho: quatro "vozes" sintéticas sobrepostas (conversa ao fundo).
    for (let v = 0; v < 4; v++) {
      const s = synthSpeech(n / SR, seed * 7 + v * 13, 110 + v * 30).audio;
      for (let i = 0; i < n; i++) out[i]! += s[i]!;
    }
  }
  return out;
}

export function rmsActive(x: Float32Array, mask?: Uint8Array): number {
  let s = 0, c = 0;
  for (let i = 0; i < x.length; i++) {
    if (mask && !mask[i]) continue;
    s += x[i]! * x[i]!;
    c++;
  }
  return Math.sqrt(s / Math.max(1, c));
}

/**
 * Mistura fala + ruído na relação sinal-ruído pedida (medida só nos trechos com fala).
 * Se a mistura precisar ser reduzida para não saturar, a fala de referência recebe o mesmo
 * ganho — senão as métricas comparariam níveis diferentes.
 */
export function mix(speech: SpeechSignal, noise: Float32Array, snrDb: number): { noisy: Float32Array; clean: Float32Array } {
  const ps = rmsActive(speech.audio, speech.active);
  const pn = rmsActive(noise);
  const g = ps / (pn * Math.pow(10, snrDb / 20));
  const noisy = new Float32Array(speech.audio.length);
  for (let i = 0; i < noisy.length; i++) noisy[i] = speech.audio[i]! + noise[i]! * g;
  const k = normalizePeak(noisy, 0.8, true);
  const clean = speech.audio.map((v) => v * k);
  return { noisy, clean };
}

/** Normaliza o pico e devolve o ganho aplicado. */
function normalizePeak(x: Float32Array, peak: number, onlyIfAbove = false): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  if (m === 0 || (onlyIfAbove && m <= peak)) return 1;
  const g = peak / m;
  for (let i = 0; i < x.length; i++) x[i]! *= g;
  return g;
}
