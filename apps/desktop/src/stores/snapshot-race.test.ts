import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './session';
import { useSocial } from './social';
import { useVoice } from './voice';

beforeEach(() => {
  useSocial.getState().reset();
  useVoice.setState({ rooms: {} });
});
afterEach(() => vi.restoreAllMocks());

describe('retrato REST × eventos em tempo real', () => {
  it('presença recebida por evento durante a busca não é sobrescrita pelo retrato antigo', async () => {
    let resolve!: (v: Record<string, 'online' | 'offline'>) => void;
    vi.spyOn(api, 'presences').mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const pending = useSocial.getState().refreshPresences();
    // Enquanto o retrato (tirado quando ela estava offline) viaja, chega o evento "online".
    useSocial.getState().setPresence('amiga', 'online');
    resolve({ amiga: 'offline', outro: 'idle' } as never);
    await pending;
    expect(useSocial.getState().presences).toEqual({ amiga: 'online', outro: 'idle' });
  });

  it('retrato vence o que mudou ANTES de a busca começar', async () => {
    useSocial.getState().setPresence('amiga', 'online');
    await new Promise((r) => setTimeout(r, 5));
    vi.spyOn(api, 'presences').mockResolvedValue({ amiga: 'idle' });
    await useSocial.getState().refreshPresences();
    expect(useSocial.getState().presences.amiga).toBe('idle');
  });

  it('salas de voz: saída recebida durante a busca não é desfeita pelo retrato', () => {
    const p = { userId: 'u1', selfMute: false, selfDeaf: false, suppressed: false, joinedAt: '2026-10-25T00:00:00Z', stream: null, camera: null };
    const startedAt = Date.now();
    useVoice.getState().setRoom('sala', 'u1', p);
    useVoice.getState().setRoom('sala', 'u1', null);
    useVoice.getState().setRooms({ sala: [p], outra: [p] }, startedAt);
    expect(useVoice.getState().rooms.sala).toBeUndefined();
    expect(Object.keys(useVoice.getState().rooms.outra ?? {})).toEqual(['u1']);
  });
});
