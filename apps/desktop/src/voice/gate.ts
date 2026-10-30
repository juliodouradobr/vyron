/**
 * Decide se o áudio do microfone deve ser transmitido agora.
 *
 * Ativação por voz usa histerese temporal: abre rápido (para não cortar o início da fala) e
 * só fecha depois de um "hangover" em silêncio (para não cortar o fim das palavras).
 * Silenciado, ensurdecido ou suprimido sempre fecha — nada capturado sai do computador.
 */
export interface GateInput {
  now: number;
  levelDb: number;
  thresholdDb: number;
  mode: 'voice_activity' | 'push_to_talk';
  pttHeld: boolean;
  muted: boolean;
  deafened: boolean;
  suppressed: boolean;
}

export interface GateState {
  open: boolean;
  lastVoiceAt: number;
}

export const HANGOVER_MS = 400;

export function gate(prev: GateState, i: GateInput): GateState {
  if (i.muted || i.deafened || i.suppressed) return { open: false, lastVoiceAt: prev.lastVoiceAt };
  if (i.mode === 'push_to_talk') return { open: i.pttHeld, lastVoiceAt: i.pttHeld ? i.now : prev.lastVoiceAt };
  if (i.levelDb >= i.thresholdDb) return { open: true, lastVoiceAt: i.now };
  return { open: i.now - prev.lastVoiceAt < HANGOVER_MS, lastVoiceAt: prev.lastVoiceAt };
}

/** Nível RMS em dBFS de um bloco de amostras (-100 para silêncio digital). */
export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}
