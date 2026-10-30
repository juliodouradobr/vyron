import type { SelfUser } from './models';
import type { PresenceStatus } from './schemas';
import type { DmChannel, Message, MessageReaction, PublicPresence, Relationship } from './social';

/**
 * Protocolo do gateway WebSocket.
 * Fluxo: conectar → servidor envia HELLO → cliente envia IDENTIFY (token) →
 * servidor responde READY → cliente envia HEARTBEAT a cada `heartbeatIntervalMs`.
 */
export const GatewayOp = {
  HELLO: 'hello',
  IDENTIFY: 'identify',
  READY: 'ready',
  HEARTBEAT: 'heartbeat',
  HEARTBEAT_ACK: 'heartbeat_ack',
  SET_STATUS: 'set_status',
  TYPING: 'typing',
  DISPATCH: 'dispatch',
} as const;

/** Códigos de fechamento (faixa 4000–4999 reservada para aplicações). */
export const GatewayClose = {
  /** Cliente não se identificou a tempo ou enviou dados inválidos. Pode reconectar. */
  PROTOCOL_ERROR: 4000,
  /** Heartbeat perdido. Pode reconectar. */
  HEARTBEAT_TIMEOUT: 4001,
  /** Token inválido, expirado ou revogado. NÃO reconectar sem novo login. */
  AUTH_FAILED: 4004,
  /** Sessão revogada em outro dispositivo. NÃO reconectar. */
  SESSION_REVOKED: 4005,
  /** Limite de conexões simultâneas por usuário. */
  TOO_MANY_CONNECTIONS: 4008,
} as const;

export const NON_RECONNECTABLE_CLOSES: ReadonlySet<number> = new Set([
  GatewayClose.AUTH_FAILED,
  GatewayClose.SESSION_REVOKED,
]);

/* ---------------- Voz ---------------- */

/** Limite da topologia P2P em malha: cada pessoa envia áudio para todas as outras. */
export const VOICE_MAX_PARTICIPANTS = 8;

export interface VoiceParticipantState {
  userId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Sem permissão de falar neste canal: os demais clientes não reproduzem o áudio desta pessoa. */
  suppressed: boolean;
  joinedAt: string;
  /** Transmissão de tela/janela em andamento (autorizada pelo servidor), ou null. */
  stream: StreamState | null;
  /** Câmera ligada (autorizada pelo servidor), ou null. Vai para todos da sala, como a voz. */
  camera: CameraState | null;
}

export interface CameraState {
  /** Id do MediaStream da câmera no WebRTC: é como quem recebe distingue câmera de tela. */
  streamId: string;
  startedAt: string;
}

/** Ids de MediaStream gerados pelo navegador (UUID, às vezes entre chaves). */
export const MEDIA_STREAM_ID_RE = /^[\w{}-]{1,64}$/;

/** O que a pessoa escolheu capturar (só o tipo; o título da janela não sai do computador dela). */
export type StreamSurface = 'monitor' | 'window' | 'browser' | 'unknown';

export interface StreamState {
  /** Id do MediaStream da tela no WebRTC (muda quando a fonte é trocada). */
  streamId: string;
  surface: StreamSurface;
  /** A captura inclui áudio do sistema/aba (depende do sistema e do navegador). */
  hasAudio: boolean;
  startedAt: string;
  /**
   * Quem está assistindo. O vídeo só é enviado para essas pessoas: assistir é opcional e explícito,
   * e quem não assiste não gasta banda nem recebe a imagem.
   */
  viewers: string[];
  /**
   * Jogar Juntos: quem está autorizado a controlar, e com quais entradas. Concedido só pelo dono da
   * transmissão, só para quem já assiste, com prazo. Assistir NÃO dá controle.
   */
  control: PlayControl | null;
}

export interface PlayControl {
  guestId: string;
  keyboard: boolean;
  mouse: boolean;
  /** Reservado: injeção de controle virtual ainda não existe no núcleo nativo. */
  gamepad: boolean;
  grantedAt: string;
  expiresAt: string;
}

/** Duração máxima de uma autorização de controle (minutos). */
export const PLAY_MAX_MINUTES = 120;

/** Uma transmissão pode ter no máximo esta quantidade de espectadores na topologia P2P. */
export const STREAM_MAX_VIEWERS = VOICE_MAX_PARTICIPANTS - 1;

/** Mensagens WebRTC trocadas entre dois participantes, sempre retransmitidas pelo servidor. */
export type VoiceSignal =
  | { kind: 'description'; description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string } }
  | { kind: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null };

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export type VoiceErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'FULL' | 'BLOCKED' | 'NOT_IN_CHANNEL';

export type ClientMessage =
  | { op: 'identify'; token: string }
  | { op: 'heartbeat'; seq: number }
  | { op: 'set_status'; status: PresenceStatus }
  | { op: 'typing'; channelId: string }
  | { op: 'voice_join'; channelId: string }
  | { op: 'voice_leave' }
  | { op: 'voice_state'; selfMute: boolean; selfDeaf: boolean }
  | { op: 'voice_signal'; to: string; signal: VoiceSignal }
  /** Começar a transmitir (exige STREAM no canal). Repetir atualiza superfície/áudio. */
  | { op: 'stream_start'; surface: StreamSurface; hasAudio: boolean; streamId: string }
  | { op: 'stream_stop' }
  /** Começar/parar de assistir à transmissão de alguém na mesma sala. */
  | { op: 'stream_watch'; userId: string; watching: boolean }
  /** Ligar (exige VIDEO no canal) ou desligar a câmera. */
  /* Jogar Juntos */
  | { op: 'play_request'; hostId: string }
  | { op: 'play_grant'; guestId: string; keyboard: boolean; mouse: boolean; gamepad: boolean; minutes: number }
  | { op: 'play_decline'; guestId: string }
  | { op: 'play_revoke' }
  | { op: 'play_release'; hostId: string }
  | { op: 'camera_on'; streamId: string }
  | { op: 'camera_off' }
  | { op: 'call_ring'; channelId: string }
  | { op: 'call_decline'; channelId: string };

/**
 * Eventos enviados pelo servidor. Cada evento só chega a quem tem permissão de ver o recurso.
 * SERVER_SYNC pede ao cliente que recarregue o servidor (canais, cargos e permissões mudaram).
 */
export type DispatchEvent =
  | { type: 'USER_UPDATE'; user: SelfUser }
  | { type: 'SESSION_REVOKED'; sessionId: string }
  | { type: 'PRESENCE_UPDATE'; userId: string; status: PublicPresence }
  | { type: 'RELATIONSHIP_UPSERT'; relationship: Relationship }
  | { type: 'RELATIONSHIP_REMOVE'; userId: string }
  | { type: 'DM_CREATE'; channel: DmChannel }
  | { type: 'SERVER_SYNC'; serverId: string }
  | { type: 'SERVER_REMOVE'; serverId: string }
  | { type: 'MEMBERS_CHANGED'; serverId: string }
  | { type: 'MESSAGE_CREATE'; message: Message }
  | { type: 'MESSAGE_UPDATE'; message: Message }
  | { type: 'MESSAGE_DELETE'; channelId: string; messageId: string }
  | { type: 'REACTIONS_UPDATE'; channelId: string; messageId: string; reactions: Array<Omit<MessageReaction, 'me'> & { userIds: string[] }> }
  | { type: 'TYPING_START'; channelId: string; userId: string }
  /** Quem está em cada canal de voz (state null = saiu). Enviado a quem pode ver o canal. */
  | { type: 'VOICE_STATE_UPDATE'; channelId: string; userId: string; state: VoiceParticipantState | null }
  /** Só para quem entrou: participantes atuais e servidores ICE (TURN com credencial temporária). */
  | { type: 'VOICE_READY'; channelId: string; participants: VoiceParticipantState[]; iceServers: IceServerConfig[]; relayAvailable: boolean }
  | { type: 'VOICE_SIGNAL'; channelId: string; from: string; signal: VoiceSignal }
  | { type: 'VOICE_ERROR'; channelId: string; code: VoiceErrorCode; message: string }
  /** Transmitir/assistir recusado (sem permissão, sala cheia de espectadores...). Não derruba a chamada. */
  | { type: 'STREAM_ERROR'; channelId: string; message: string; kind?: 'screen' | 'camera' | 'play' }
  /** Só para o dono da transmissão: alguém que assiste pediu para jogar junto. */
  | { type: 'PLAY_REQUEST'; channelId: string; from: string }
  /** Só para quem pediu: o dono recusou. */
  | { type: 'PLAY_DECLINED'; channelId: string; hostId: string }
  | { type: 'CALL_RING'; channelId: string; from: string }
  | { type: 'CALL_DECLINE'; channelId: string; userId: string };

export type ServerMessage =
  | { op: 'hello'; heartbeatIntervalMs: number }
  | { op: 'ready'; user: SelfUser; sessionId: string }
  | { op: 'heartbeat_ack'; seq: number }
  | { op: 'dispatch'; event: DispatchEvent };
