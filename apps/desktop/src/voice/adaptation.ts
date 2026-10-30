/**
 * Adaptação de bitrate de envio a partir das estatísticas do WebRTC.
 * Desce rápido quando a rede piora (perda/jitter/RTT altos) e sobe devagar, um degrau por vez,
 * só depois de vários intervalos bons — evita oscilar e evita aumentar latência por qualidade
 * que ninguém percebe.
 */
export const BITRATE_STEPS = [16_000, 24_000, 32_000, 40_000] as const;

export interface LinkSample {
  /** Fração de pacotes perdidos no intervalo (0–1). */
  loss: number;
  /** Jitter em ms. */
  jitterMs: number;
  /** RTT em ms. */
  rttMs: number;
}

export interface AdaptState {
  step: number;
  goodStreak: number;
}

export const initialAdapt = (): AdaptState => ({ step: BITRATE_STEPS.length - 1, goodStreak: 0 });

const UPGRADE_AFTER = 5; // intervalos bons seguidos antes de subir

export function adapt(state: AdaptState, s: LinkSample): AdaptState {
  const bad = s.loss > 0.05 || s.jitterMs > 60 || s.rttMs > 400;
  const poor = s.loss > 0.15 || s.rttMs > 800;
  if (poor) return { step: 0, goodStreak: 0 };
  if (bad) return { step: Math.max(0, state.step - 1), goodStreak: 0 };
  const goodStreak = state.goodStreak + 1;
  if (goodStreak >= UPGRADE_AFTER && state.step < BITRATE_STEPS.length - 1) return { step: state.step + 1, goodStreak: 0 };
  return { step: state.step, goodStreak };
}

export type LinkQuality = 'good' | 'fair' | 'poor';
export function quality(s: LinkSample): LinkQuality {
  if (s.loss > 0.1 || s.rttMs > 500 || s.jitterMs > 80) return 'poor';
  if (s.loss > 0.02 || s.rttMs > 200 || s.jitterMs > 30) return 'fair';
  return 'good';
}
