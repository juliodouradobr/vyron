import { beforeEach, describe, expect, it } from 'vitest';
import { useVoice } from './voice';

const state = () => {
  const { micMuted, deafened } = useVoice.getState();
  return { micMuted, deafened };
};

beforeEach(() => useVoice.setState({ micMuted: false, deafened: false, mutedBeforeDeafen: false }));

describe('controles de voz', () => {
  it('ensurdecer também silencia o microfone e restaura o estado anterior', () => {
    useVoice.getState().toggleDeafen();
    expect(state()).toEqual({ micMuted: true, deafened: true });
    useVoice.getState().toggleDeafen();
    expect(state()).toEqual({ micMuted: false, deafened: false });
  });

  it('mantém o microfone silenciado se já estava antes de ensurdecer', () => {
    useVoice.getState().toggleMute();
    useVoice.getState().toggleDeafen();
    useVoice.getState().toggleDeafen();
    expect(state()).toEqual({ micMuted: true, deafened: false });
  });

  it('reativar o microfone enquanto surdo reativa o áudio', () => {
    useVoice.getState().toggleDeafen();
    useVoice.getState().toggleMute();
    expect(state()).toEqual({ micMuted: false, deafened: false });
  });

  it('persiste entre reinicializações', () => {
    useVoice.getState().toggleMute();
    expect(JSON.parse(localStorage.getItem('nexo.voice')!).micMuted).toBe(true);
  });
});
