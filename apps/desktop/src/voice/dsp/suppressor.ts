import type { Denoiser } from './rnnoise';

/**
 * Núcleo da supressão de ruído — o mesmo código roda no AudioWorklet, no OfflineAudioContext
 * (comparação A/B) e nos testes do Node.
 *
 * Fluxo: blocos de qualquer tamanho → quadros de 480 amostras (10 ms a 48 kHz) → RNNoise →
 * mistura com o sinal original alinhado → portão opcional → saída.
 *
 * O RNNoise devolve cada quadro com 480 amostras de atraso (medido; é a sobreposição de janelas
 * dele). Para misturar o sinal processado com o original sem cancelamentos de fase, o original
 * usado na mistura é o quadro anterior. Latência total adicionada: 20 ms (10 ms de quadro + 10 ms
 * do algoritmo). Nos modos sem rede neural o nó sai da cadeia e não adiciona latência alguma.
 */

export type NoiseMode = 'auto' | 'strong' | 'balanced' | 'light' | 'natural' | 'economy' | 'off';
/** O que de fato está sendo aplicado (o automático escolhe entre os três primeiros). */
export type AppliedMode = 'strong' | 'balanced' | 'natural' | 'light' | 'passthrough';

const dbToGain = (db: number) => Math.pow(10, db / 20);

interface ModeParams {
  /** Fração do sinal original misturada de volta: limita quanto o ruído pode ser reduzido. */
  dryMix: number;
  /** Portão guiado pela detecção de voz: atenua o resíduo entre as palavras. */
  gate: boolean;
}

export const MODE_PARAMS: Record<Exclude<AppliedMode, 'passthrough'>, ModeParams> = {
  // Prioriza silêncio: rede neural completa + portão entre palavras.
  strong: { dryMix: 0, gate: true },
  // Rede neural completa, sem portão.
  balanced: { dryMix: 0, gate: false },
  // Redução limitada a ~18 dB: mantém um pouco do ambiente, menos artefatos.
  light: { dryMix: dbToGain(-18), gate: false },
  // Redução limitada a ~10 dB: voz o mais natural possível.
  natural: { dryMix: dbToGain(-10), gate: false },
};

/** Modos que usam a rede neural (os demais tiram o nó da cadeia de áudio). */
export const usesNeural = (m: NoiseMode) => m !== 'off' && m !== 'economy';

const GATE_FLOOR = dbToGain(-25);
const GATE_OPEN_VAD = 0.5;
const GATE_HANGOVER_FRAMES = 15; // 150 ms sem voz antes de começar a fechar
const GATE_RELEASE = 0.7; // por quadro: fecha em ~100 ms, sem "bombear"

/**
 * Automático: decide pela relação fala/ruído estimada (SNR = nível da fala nos quadros com voz −
 * nível do ruído nas pausas). A bancada mostrou que, com pouco ruído, a rede neural distorce mais
 * do que limpa — então ambiente silencioso recebe processamento mínimo e ambiente barulhento,
 * o máximo. O Forte fica de fora: com muito ruído o detector de voz erra mais e o portão passa a
 * cortar palavras (38% dos quadros de fala com ruído rosa a 0 dB, na bancada). Ele continua
 * disponível como escolha manual para quem prioriza silêncio acima de tudo.
 */
const AUTO_LADDER: Array<Exclude<AppliedMode, 'passthrough'>> = ['balanced', 'light', 'natural'];
// Limiares calibrados na bancada: a estimativa fica ~2 dB abaixo da SNR real com ruído estacionário.
const AUTO_SNR_STEPS = [9, 17];
const AUTO_HYSTERESIS_DB = 3;
/** Ruído de fundo abaixo disso é silêncio de estúdio: processamento mínimo, qualquer que seja a SNR. */
const AUTO_QUIET_FLOOR_DB = -70;
const AUTO_FIRST_DECISION_FRAMES = 100; // 1 s
const AUTO_MIN_DWELL_FRAMES = 300; // 3 s numa decisão antes de trocar
/** Se o modo atual estiver atenuando a própria fala além disso, o automático recua um degrau. */
const AUTO_MAX_SPEECH_LOSS_DB = 6;

export interface SuppressorStats {
  applied: AppliedMode;
  /** Probabilidade média de voz no último intervalo. */
  vad: number;
  /** Nível do ruído de fundo (dBFS) nos quadros sem voz. */
  noiseFloorDb: number;
  /** Quanto o ruído foi reduzido nos quadros sem voz (dB). */
  noiseReductionDb: number;
  /** Quanto a fala foi atenuada nos quadros com voz (dB) — indicador de distorção/cortes. */
  speechLossDb: number;
  /** Relação fala/ruído estimada (dB); null até haver fala suficiente. */
  snrDb: number | null;
  frames: number;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}
const toDb = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

export class SuppressorCore {
  readonly frameSize: number;
  private mode: NoiseMode = 'balanced';
  private applied: AppliedMode = 'balanced';
  private readonly inBuf: Float32Array;
  private inFill = 0;
  private readonly prevIn: Float32Array;
  private readonly wet: Float32Array;
  private readonly mixed: Float32Array;
  private readonly ring: Float32Array;
  private ringRead = 0;
  private ringWrite = 0;
  private ringCount = 0;
  private gateGain = 1;
  private sinceVoice = 1e9;
  private prevVad = 0;
  private dwell = 0;

  // Estatísticas (médias exponenciais).
  private noiseFloorDb = -90;
  /** Médias em POTÊNCIA (não em dB): média de dB subestima sinais que oscilam, como a fala. */
  private noisePow = 0;
  private speechPow: number | null = null;
  private decided = false;
  private reductionDb = 0;
  /** Potência da saída nos quadros com voz (EMA). */
  private speechOutPow = 0;
  private vadAcc = 0;
  private vadN = 0;
  private frames = 0;

  constructor(
    private readonly denoiser: Denoiser | null,
    frameSize = 480,
  ) {
    this.frameSize = denoiser?.frameSize ?? frameSize;
    const n = this.frameSize;
    this.inBuf = new Float32Array(n);
    this.prevIn = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.mixed = new Float32Array(n);
    this.ring = new Float32Array(n * 8);
    // Pré-preenchimento de um quadro: garante saída contínua com blocos de 128 amostras.
    this.ringWrite = this.ringCount = n;
  }

  /** Latência que este nó adiciona, em amostras. */
  get latencySamples(): number {
    return this.frameSize * 2;
  }

  setMode(mode: NoiseMode): void {
    this.mode = mode;
    if (mode === 'auto') {
      this.applied = 'balanced';
      this.dwell = 0;
      this.decided = false;
    } else if (mode === 'off' || mode === 'economy' || !this.denoiser) this.applied = 'passthrough';
    else this.applied = mode;
  }

  /** Processa um bloco; `output` tem o mesmo tamanho de `input`. */
  process(input: Float32Array, output: Float32Array): void {
    let i = 0;
    while (i < input.length) {
      const take = Math.min(this.frameSize - this.inFill, input.length - i);
      this.inBuf.set(input.subarray(i, i + take), this.inFill);
      this.inFill += take;
      i += take;
      if (this.inFill === this.frameSize) {
        this.processFrame();
        this.inFill = 0;
      }
    }
    for (let k = 0; k < output.length; k++) {
      if (this.ringCount > 0) {
        output[k] = this.ring[this.ringRead]!;
        this.ringRead = (this.ringRead + 1) % this.ring.length;
        this.ringCount--;
      } else output[k] = 0; // não deve acontecer (ver pré-preenchimento)
    }
  }

  private processFrame(): void {
    const n = this.frameSize;
    const dry = this.prevIn; // alinhado com a saída do RNNoise (atraso de um quadro)
    let vad = 0;
    if (this.applied === 'passthrough' || !this.denoiser) {
      this.mixed.set(dry);
    } else {
      vad = this.denoiser.process(this.inBuf, this.wet);
      const p = MODE_PARAMS[this.applied];
      for (let k = 0; k < n; k++) this.mixed[k] = this.wet[k]! * (1 - p.dryMix) + dry[k]! * p.dryMix;
      // A voz detectada agora corresponde ao quadro seguinte ao que sai: usar o maior dos dois
      // abre o portão um quadro antes da fala (não corta o começo das palavras).
      const voice = Math.max(vad, this.prevVad);
      if (p.gate) {
        this.sinceVoice = voice >= GATE_OPEN_VAD ? 0 : this.sinceVoice + 1;
        const target = this.sinceVoice <= GATE_HANGOVER_FRAMES ? 1 : GATE_FLOOR;
        const next = target >= this.gateGain ? target : Math.max(target, this.gateGain * GATE_RELEASE);
        // Rampa dentro do quadro: sem cliques.
        for (let k = 0; k < n; k++) this.mixed[k]! *= this.gateGain + ((next - this.gateGain) * (k + 1)) / n;
        this.gateGain = next;
      } else this.gateGain = 1;
      this.updateStats(dry, this.mixed, voice);
    }
    this.prevVad = vad;
    this.prevIn.set(this.inBuf);
    for (let k = 0; k < n; k++) {
      this.ring[this.ringWrite] = this.mixed[k]!;
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
    }
    this.ringCount += n;
  }

  private updateStats(dry: Float32Array, out: Float32Array, vad: number) {
    this.frames++;
    this.vadAcc += vad;
    this.vadN++;
    const dr = rms(dry);
    const or = rms(out);
    const d = toDb(dr);
    const o = toDb(or);
    if (vad < 0.15 && d > -100) {
      this.noisePow += (dr * dr - this.noisePow) * (this.frames < 50 ? 0.2 : 0.03);
      this.noiseFloorDb = toDb(Math.sqrt(this.noisePow));
      this.reductionDb += (Math.max(0, d - o) - this.reductionDb) * 0.05;
    } else if (vad > 0.85 && d > -70) {
      const first = this.speechPow == null;
      this.speechPow = first ? dr * dr : this.speechPow! + (dr * dr - this.speechPow!) * 0.03;
      this.speechOutPow = first ? or * or : this.speechOutPow + (or * or - this.speechOutPow) * 0.03;
    }
    if (this.mode === 'auto') this.autoDecide();
  }

  /**
   * SNR estimada (dB), ou null enquanto ainda não houve fala suficiente para medir.
   * A potência dos quadros "com voz" inclui o ruído: ele é descontado antes da razão.
   */
  get estimatedSnrDb(): number | null {
    if (this.speechPow == null) return null;
    const clean = Math.max(this.speechPow - this.noisePow, 1e-12);
    return 10 * Math.log10(clean / Math.max(this.noisePow, 1e-12));
  }

  /**
   * Quanto a fala perdeu (dB): saída nos quadros com voz comparada à fala limpa estimada
   * (potência com voz − potência do ruído). Remover o ruído não conta como perda; comer a voz, sim.
   */
  get speechLossDb(): number {
    if (this.speechPow == null) return 0;
    const clean = Math.max(this.speechPow - this.noisePow, 1e-12);
    return Math.max(0, 10 * Math.log10(clean / Math.max(this.speechOutPow, 1e-12)));
  }

  private autoDecide() {
    this.dwell++;
    const snr = this.estimatedSnrDb;
    if (snr == null) return; // sem fala ainda: mantém o equilibrado
    if (this.dwell < (this.decided ? AUTO_MIN_DWELL_FRAMES : AUTO_FIRST_DECISION_FRAMES)) return;
    const cur = AUTO_LADDER.indexOf(this.applied as (typeof AUTO_LADDER)[number]);
    // Nível alvo pela SNR; para sair do degrau atual é preciso passar o limiar com folga (histerese).
    const levelFor = (s: number) => AUTO_SNR_STEPS.filter((t) => s >= t).length;
    let target = levelFor(snr);
    if (target > cur) target = Math.max(cur, levelFor(snr - AUTO_HYSTERESIS_DB));
    else if (target < cur) target = Math.min(cur, levelFor(snr + AUTO_HYSTERESIS_DB));
    if (this.noiseFloorDb < AUTO_QUIET_FLOOR_DB) target = AUTO_LADDER.length - 1;
    // Proteção de inteligibilidade: atenuando a fala demais, um degrau mais suave.
    if (this.speechLossDb > AUTO_MAX_SPEECH_LOSS_DB) target = Math.max(target, Math.min(cur + 1, AUTO_LADDER.length - 1));
    const next = AUTO_LADDER[target]!;
    this.decided = true;
    if (next !== this.applied) {
      this.applied = next;
      this.dwell = 0;
    }
  }

  /** Lê e zera a média de VAD do intervalo. */
  stats(): SuppressorStats {
    const s: SuppressorStats = {
      applied: this.applied,
      vad: this.vadN ? this.vadAcc / this.vadN : 0,
      noiseFloorDb: Math.round(this.noiseFloorDb),
      noiseReductionDb: Math.round(this.reductionDb * 10) / 10,
      speechLossDb: Math.round(this.speechLossDb * 10) / 10,
      snrDb: this.estimatedSnrDb == null ? null : Math.round(this.estimatedSnrDb),
      frames: this.frames,
    };
    this.vadAcc = this.vadN = 0;
    return s;
  }
}
