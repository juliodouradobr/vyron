/**
 * Adaptação do vídeo à rede de cada espectador (além da que o próprio codificador já faz).
 * Perda de pacotes ou falta de banda persistente baixam o teto de bitrate um degrau; rede boa
 * por um tempo sobe de volta. Cada espectador tem o seu estado: um espectador com rede ruim
 * não piora a imagem dos outros.
 */

/** Fração do bitrate-alvo em cada nível. */
export const VIDEO_LEVELS = [1, 0.75, 0.55, 0.4, 0.28] as const;

export interface VideoAdaptState {
  level: number;
  bad: number;
  good: number;
  reason: string | null;
}

export interface VideoSample {
  loss: number | null;
  rttMs: number | null;
  limitation: 'none' | 'bandwidth' | 'cpu' | 'other';
}

export const initialVideoAdapt = (): VideoAdaptState => ({ level: 0, bad: 0, good: 0, reason: null });

const BAD_LOSS = 0.05;
const GOOD_LOSS = 0.01;
const BAD_RTT = 400;
/** Amostras seguidas (a cada 2 s) para baixar e para subir: desce rápido, sobe com cautela. */
const DOWN_AFTER = 2;
const UP_AFTER = 5;

/**
 * Só sinais reais de congestionamento (perda e latência) mexem no teto. A limitação "bandwidth"
 * informada pelo codificador NÃO entra aqui: o navegador a reporta também enquanto sobe a estimativa
 * de banda e quando bate no nosso próprio teto — usar isso para baixar o teto criaria um ciclo
 * que derruba a qualidade sem motivo (observado em teste real). Ela continua sendo exibida como explicação.
 */
export function adaptVideo(s: VideoAdaptState, x: VideoSample): VideoAdaptState {
  const loss = x.loss ?? 0;
  const why = loss > BAD_LOSS ? `Perda de ${Math.round(loss * 100)}% dos pacotes` : (x.rttMs ?? 0) > BAD_RTT ? `Latência alta (${x.rttMs} ms)` : null;
  if (why) {
    const bad = s.bad + 1;
    if (bad >= DOWN_AFTER && s.level < VIDEO_LEVELS.length - 1) {
      const level = s.level + 1;
      return { level, bad: 0, good: 0, reason: `${why}: bitrate reduzido para ${Math.round(VIDEO_LEVELS[level]! * 100)}% do alvo.` };
    }
    return { ...s, bad, good: 0 };
  }
  const healthy = loss <= GOOD_LOSS;
  if (!healthy) return { ...s, bad: 0, good: 0 };
  const good = s.good + 1;
  if (good >= UP_AFTER && s.level > 0) {
    const level = s.level - 1;
    return { level, bad: 0, good: 0, reason: level === 0 ? null : `Rede melhorou: bitrate em ${Math.round(VIDEO_LEVELS[level]! * 100)}% do alvo.` };
  }
  return { ...s, bad: 0, good };
}
