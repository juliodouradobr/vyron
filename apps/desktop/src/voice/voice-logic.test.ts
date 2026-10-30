import { describe, expect, it } from 'vitest';
import { BITRATE_STEPS, adapt, initialAdapt, quality } from './adaptation';
import { HANGOVER_MS, gate, rmsDb, type GateInput } from './gate';
import { tuneOpus } from './opus';

const SDP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=0', 'a=rtpmap:0 PCMU/8000', ''].join('\r\n');

describe('tuneOpus', () => {
  it('ativa FEC e DTX, força mono e limita o bitrate preservando parâmetros existentes', () => {
    const out = tuneOpus(SDP);
    const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))!;
    expect(fmtp).toContain('minptime=10');
    expect(fmtp).toContain('useinbandfec=1');
    expect(fmtp).toContain('usedtx=1');
    expect(fmtp).toContain('stereo=0');
    expect(fmtp).toContain('maxaveragebitrate=40000');
    expect(out).toContain('a=rtpmap:0 PCMU/8000');
  });
  it('cria a linha fmtp quando ela não existe e não mexe em SDP sem Opus', () => {
    const noFmtp = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=0\r\n', '');
    expect(tuneOpus(noFmtp)).toMatch(/a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 useinbandfec=1/);
    const pcmu = 'v=0\r\na=rtpmap:0 PCMU/8000\r\n';
    expect(tuneOpus(pcmu)).toBe(pcmu);
  });
});

describe('adapt (bitrate)', () => {
  const good = { loss: 0, jitterMs: 5, rttMs: 30 };
  it('começa no teto, desce um degrau com rede ruim e vai ao mínimo com rede péssima', () => {
    let s = initialAdapt();
    expect(BITRATE_STEPS[s.step]).toBe(40_000);
    s = adapt(s, { loss: 0.08, jitterMs: 10, rttMs: 50 });
    expect(BITRATE_STEPS[s.step]).toBe(32_000);
    s = adapt(s, { loss: 0.3, jitterMs: 10, rttMs: 50 });
    expect(BITRATE_STEPS[s.step]).toBe(16_000);
  });
  it('sobe devagar: só após 5 intervalos bons seguidos, um degrau por vez', () => {
    let s = { step: 0, goodStreak: 0 };
    for (let i = 0; i < 4; i++) s = adapt(s, good);
    expect(s.step).toBe(0);
    s = adapt(s, good);
    expect(s.step).toBe(1);
    s = adapt(s, { loss: 0.06, jitterMs: 5, rttMs: 30 });
    expect(s).toEqual({ step: 0, goodStreak: 0 });
  });
  it('classifica a qualidade do enlace', () => {
    expect(quality(good)).toBe('good');
    expect(quality({ loss: 0.03, jitterMs: 5, rttMs: 30 })).toBe('fair');
    expect(quality({ loss: 0.2, jitterMs: 5, rttMs: 30 })).toBe('poor');
  });
});

describe('gate (ativação por voz / push-to-talk)', () => {
  const base: GateInput = { now: 1000, levelDb: -20, thresholdDb: -50, mode: 'voice_activity', pttHeld: false, muted: false, deafened: false, suppressed: false };
  it('abre com voz e mantém aberto durante o hangover', () => {
    let s = gate({ open: false, lastVoiceAt: 0 }, base);
    expect(s.open).toBe(true);
    s = gate(s, { ...base, now: 1000 + HANGOVER_MS - 1, levelDb: -80 });
    expect(s.open).toBe(true);
    s = gate(s, { ...base, now: 1000 + HANGOVER_MS + 1, levelDb: -80 });
    expect(s.open).toBe(false);
  });
  it('silenciado, ensurdecido ou suprimido nunca transmite', () => {
    for (const k of ['muted', 'deafened', 'suppressed'] as const) {
      expect(gate({ open: true, lastVoiceAt: 1000 }, { ...base, [k]: true }).open).toBe(false);
    }
  });
  it('push-to-talk só transmite com a tecla pressionada, independente do volume', () => {
    expect(gate({ open: false, lastVoiceAt: 0 }, { ...base, mode: 'push_to_talk', pttHeld: false }).open).toBe(false);
    expect(gate({ open: false, lastVoiceAt: 0 }, { ...base, mode: 'push_to_talk', pttHeld: true, levelDb: -99 }).open).toBe(true);
  });
  it('mede nível RMS em dBFS', () => {
    expect(rmsDb(new Float32Array(128))).toBe(-100);
    expect(rmsDb(new Float32Array(128).fill(1))).toBeCloseTo(0);
    expect(rmsDb(new Float32Array(128).fill(0.1))).toBeCloseTo(-20);
  });
});
