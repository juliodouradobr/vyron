import { create } from 'zustand';
import type { StreamSurface, VoiceParticipantState } from '@nexo/protocol';
import type { PeerStats } from '../voice/PeerMesh';
import type { CameraQuality } from '../voice/camera';
import type { StreamQuality } from '../voice/screen/quality';
import type { VideoRecvStats, VideoSendStats } from '../voice/screen/stats';
import type { AppliedMode, NoiseMode } from '../voice/dsp/suppressor';

const KEY = 'nexo.voice';

/** Quando cada sala mudou por evento em tempo real (ver setRooms). */
const roomTouched = new Map<string, number>();

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface NoiseState {
  /** Modo efetivo (pode ser Economia por fallback, mesmo com outro escolhido). */
  mode: NoiseMode;
  /** O que está sendo aplicado agora: o Automático escolhe entre Equilibrado, Leve e Natural. */
  applied: AppliedMode | 'economy' | 'off' | 'loading';
  noiseReductionDb: number | null;
  noiseFloorDb: number | null;
  speechLossDb: number | null;
  snrDb: number | null;
  /** Carga do processamento na thread de áudio (%). */
  loadPct: number | null;
  /** Custo medido do modelo neste computador (µs por 10 ms de áudio). */
  costUs: number | null;
  /** Caiu para Economia por falta de desempenho ou falha. */
  fallback: boolean;
}

/** Nossa transmissão de tela em andamento. */
export interface LocalScreenState {
  quality: StreamQuality;
  surface: StreamSurface;
  /** Pedimos áudio e a fonte forneceu. */
  hasAudio: boolean;
  /** Pedimos áudio mas o sistema não forneceu para essa fonte. */
  audioUnavailable: boolean;
  /** O servidor ainda não confirmou (permissão verificada lá). */
  pending: boolean;
  startedAt: number;
  /** A própria captura, para a prévia local. */
  preview: MediaStream;
}

export interface PlayHostState {
  /** native = entradas aplicadas no sistema (app para Windows); monitor = só exibidas (navegador). */
  sink: 'native' | 'monitor';
  accepted: number;
  blocked: number;
  lastBlock: string | null;
  /** Últimos eventos recebidos, para o anfitrião ver exatamente o que chega. */
  recent: string[];
  /** Janela alvo escolhida (app para Windows). */
  windowTitle: string | null;
}

/** Nossa câmera ligada. */
export interface LocalCameraState {
  quality: CameraQuality;
  /** O servidor ainda não confirmou (permissão verificada lá). */
  pending: boolean;
  startedAt: number;
  preview: MediaStream;
  /** Nome do dispositivo em uso (para mostrar qual câmera está ligada). */
  label: string;
}

export interface ViewerSendState extends VideoSendStats {
  /** Nível de adaptação à rede deste espectador (0 = alvo cheio). */
  level: number;
  reasons: string[];
}

export interface VoiceState {
  micMuted: boolean;
  deafened: boolean;
  /** Estado do microfone antes de ensurdecer — restaurado ao desfazer. */
  mutedBeforeDeafen: boolean;

  /** Quem está em cada sala de voz que o usuário pode ver. */
  rooms: Record<string, Record<string, VoiceParticipantState>>;
  channelId: string | null;
  status: VoiceStatus;
  error: string | null;
  notice: string | null;
  relayAvailable: boolean;
  speaking: Record<string, boolean>;
  peers: Record<string, PeerStats>;
  /** Microfone transmitindo agora (portão aberto). */
  transmitting: boolean;
  /** Na sala sem microfone (sem dispositivo ou acesso negado). */
  listenOnly: boolean;
  /** Supressão de ruído em uso na chamada: modo pedido, o que está sendo aplicado e medições ao vivo. */
  noise: NoiseState | null;
  pttHeld: boolean;
  incomingCall: { channelId: string; from: string } | null;
  outgoingCall: { channelId: string; startedAt: number } | null;

  /* ---- Transmissão de tela (Etapa 5) ---- */
  screen: LocalScreenState | null;
  /** Estatísticas reais do que enviamos, por espectador. */
  screenSend: Record<string, ViewerSendState>;
  /** Vídeo que chega até nós (tela de quem assistimos e câmeras), por pessoa e id do stream. */
  remoteMedia: Record<string, Record<string, MediaStream>>;
  /** Estatísticas reais do que recebemos, por pessoa e id do stream. */
  mediaRecv: Record<string, Record<string, VideoRecvStats>>;
  /* ---- Jogar Juntos ---- */
  /** Pedidos de controle recebidos (somos o anfitrião). */
  playRequests: Array<{ from: string; at: number }>;
  /** Pedido nosso aguardando resposta. */
  playPending: { hostId: string; at: number } | null;
  /** Estamos controlando ativamente a transmissão desta pessoa (captura de teclado/mouse ligada). */
  playControlling: string | null;
  /** Lado do anfitrião: como as entradas estão sendo tratadas e o que chegou. */
  playHost: PlayHostState | null;
  /* ---- Câmera ---- */
  camera: LocalCameraState | null;
  /** Estatísticas reais do envio da câmera, por pessoa. */
  cameraSend: Record<string, VideoSendStats>;
  /** Transmissão aberta em destaque na sala. */
  focusedStream: string | null;

  toggleMute(): void;
  toggleDeafen(): void;
  setRoom(channelId: string, userId: string, state: VoiceParticipantState | null): void;
  setRooms(rooms: Record<string, VoiceParticipantState[]>, startedAt?: number): void;
  patch(p: Partial<Omit<VoiceState, 'toggleMute' | 'toggleDeafen' | 'setRoom' | 'setRooms' | 'patch'>>): void;
}

function read(): Pick<VoiceState, 'micMuted' | 'deafened' | 'mutedBeforeDeafen'> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { micMuted: !!v.micMuted, deafened: !!v.deafened, mutedBeforeDeafen: !!v.mutedBeforeDeafen };
  } catch {
    return { micMuted: false, deafened: false, mutedBeforeDeafen: false };
  }
}

/**
 * Estado de voz. micMuted desliga a faixa na origem (nenhum áudio capturado é enviado), não só
 * o volume. Ensurdecer também silencia o microfone, como esperado por quem usa apps de voz.
 */
export const useVoice = create<VoiceState>((set, get) => ({
  ...read(),
  rooms: {},
  channelId: null,
  status: 'idle',
  error: null,
  notice: null,
  relayAvailable: false,
  speaking: {},
  peers: {},
  transmitting: false,
  listenOnly: false,
  noise: null,
  pttHeld: false,
  incomingCall: null,
  outgoingCall: null,
  screen: null,
  screenSend: {},
  remoteMedia: {},
  mediaRecv: {},
  camera: null,
  cameraSend: {},
  playRequests: [],
  playPending: null,
  playControlling: null,
  playHost: null,
  focusedStream: null,

  toggleMute() {
    const { micMuted, deafened } = get();
    // Reativar o microfone enquanto surdo também reativa o áudio.
    if (deafened && micMuted) set({ micMuted: false, deafened: false, mutedBeforeDeafen: false });
    else set({ micMuted: !micMuted });
  },
  toggleDeafen() {
    const { deafened, micMuted, mutedBeforeDeafen } = get();
    if (deafened) set({ deafened: false, micMuted: mutedBeforeDeafen });
    else set({ deafened: true, mutedBeforeDeafen: micMuted, micMuted: true });
  },

  setRoom(channelId, userId, state) {
    roomTouched.set(channelId, Date.now());
    const room = { ...get().rooms[channelId] };
    if (state) room[userId] = state;
    else delete room[userId];
    const rooms = { ...get().rooms };
    if (Object.keys(room).length) rooms[channelId] = room;
    else delete rooms[channelId];
    set({ rooms });
  },
  setRooms(list, startedAt = 0) {
    const rooms: Record<string, Record<string, VoiceParticipantState>> = Object.fromEntries(
      Object.entries(list).map(([c, ps]) => [c, Object.fromEntries(ps.map((p) => [p.userId, p]))]),
    );
    // Salas que mudaram por evento depois que o retrato foi pedido mantêm o estado do evento.
    for (const [c, at] of roomTouched) {
      if (at < startedAt) continue;
      const cur = get().rooms[c];
      if (cur) rooms[c] = cur;
      else delete rooms[c];
    }
    set({ rooms });
  },
  patch: (p) => set(p),
}));

/** Vídeo recebido de alguém para um tipo de mídia, conforme o id que o servidor anunciou. */
export function remoteMediaOf(s: VoiceState, userId: string, kind: 'screen' | 'camera'): MediaStream | undefined {
  const st = s.channelId ? s.rooms[s.channelId]?.[userId] : undefined;
  const id = kind === 'screen' ? st?.stream?.streamId : st?.camera?.streamId;
  return id ? s.remoteMedia[userId]?.[id] : undefined;
}

export function mediaRecvOf(s: VoiceState, userId: string, kind: 'screen' | 'camera'): VideoRecvStats | undefined {
  const st = s.channelId ? s.rooms[s.channelId]?.[userId] : undefined;
  const id = kind === 'screen' ? st?.stream?.streamId : st?.camera?.streamId;
  return id ? s.mediaRecv[userId]?.[id] : undefined;
}

useVoice.subscribe((s, prev) => {
  if (s.micMuted === prev.micMuted && s.deafened === prev.deafened && s.mutedBeforeDeafen === prev.mutedBeforeDeafen) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ micMuted: s.micMuted, deafened: s.deafened, mutedBeforeDeafen: s.mutedBeforeDeafen }));
  } catch {
    /* sem armazenamento local */
  }
});
