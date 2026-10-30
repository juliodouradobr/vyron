import {
  NON_RECONNECTABLE_CLOSES,
  type ClientMessage,
  type DispatchEvent,
  type PresenceStatus,
  type SelfUser,
  type ServerMessage,
} from '@nexo/protocol';

export type GatewayState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface GatewayCallbacks {
  onState(state: GatewayState, info?: { retryInMs?: number }): void;
  onReady(user: SelfUser, sessionId: string): void;
  onDispatch(event: DispatchEvent): void;
  /** Fechamento definitivo (sessão revogada/inválida): o app deve voltar para o login. */
  onFatal(code: number): void;
  onLatency?(ms: number): void;
}

type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

export interface GatewayOptions {
  url: string;
  getToken: () => string | null;
  callbacks: GatewayCallbacks;
  createSocket?: (url: string) => SocketLike;
  /** Para testes: aleatoriedade do jitter. */
  random?: () => number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** Conexão que não chega ao READY nesse prazo (servidor reiniciando, proxy travado) é refeita. */
export const READY_TIMEOUT_MS = 15_000;

/** Atraso exponencial com jitter "full": evita que todos os clientes reconectem no mesmo instante. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * Cliente do gateway: identifica, mantém heartbeat, mede latência e reconecta com backoff.
 * Se um ACK não chega antes do próximo heartbeat, a conexão é considerada morta (zumbi) e é refeita.
 */
export class GatewayClient {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private awaitingAck = false;
  private sentAt = 0;
  private readonly createSocket: (url: string) => SocketLike;

  constructor(private readonly opts: GatewayOptions) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close(1000, 'cliente encerrou');
    }
    this.opts.callbacks.onState('idle');
  }

  /** Força uma tentativa imediata (ex.: rede voltou). */
  reconnectNow(): void {
    if (this.stopped || this.socket) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open();
  }

  setStatus(status: PresenceStatus): void {
    this.send({ op: 'set_status', status });
  }

  sendTyping(channelId: string): void {
    this.send({ op: 'typing', channelId });
  }

  get connected(): boolean {
    return !!this.socket && this.socket.readyState === 1;
  }

  send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify(msg));
  }

  private open(): void {
    const token = this.opts.getToken();
    if (!token) return this.opts.callbacks.onFatal(4004);
    this.opts.callbacks.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const s = this.createSocket(this.opts.url);
    this.socket = s;
    this.readyTimer = setTimeout(() => s.close(4900, 'handshake sem resposta'), READY_TIMEOUT_MS);
    s.onmessage = (ev) => this.handle(JSON.parse(String(ev.data)) as ServerMessage, token);
    s.onerror = () => {
      /* o evento close vem em seguida e decide o que fazer */
    };
    s.onclose = (ev) => {
      this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (NON_RECONNECTABLE_CLOSES.has(ev.code)) {
        this.stopped = true;
        this.opts.callbacks.onState('idle');
        this.opts.callbacks.onFatal(ev.code);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handle(msg: ServerMessage, token: string): void {
    switch (msg.op) {
      case 'hello':
        this.send({ op: 'identify', token });
        this.startHeartbeat(msg.heartbeatIntervalMs);
        break;
      case 'ready':
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.attempt = 0;
        this.opts.callbacks.onState('connected');
        this.opts.callbacks.onReady(msg.user, msg.sessionId);
        break;
      case 'heartbeat_ack':
        if (msg.seq === this.seq) {
          this.awaitingAck = false;
          this.opts.callbacks.onLatency?.(Date.now() - this.sentAt);
        }
        break;
      case 'dispatch':
        this.opts.callbacks.onDispatch(msg.event);
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.awaitingAck = false;
    const beat = () => {
      if (this.awaitingAck) {
        // Sem resposta ao último heartbeat: conexão zumbi.
        this.socket?.close(4900, 'heartbeat sem resposta');
        return;
      }
      this.seq += 1;
      this.awaitingAck = true;
      this.sentAt = Date.now();
      this.send({ op: 'heartbeat', seq: this.seq });
    };
    this.heartbeatTimer = setInterval(beat, intervalMs);
    // Primeiro heartbeat logo após o identify, para medir a latência cedo.
    this.firstBeatTimer = setTimeout(beat, 50);
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt, this.opts.random);
    this.attempt += 1;
    this.opts.callbacks.onState(navigator.onLine === false ? 'offline' : 'reconnecting', { retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.firstBeatTimer) clearTimeout(this.firstBeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.heartbeatTimer = null;
    this.firstBeatTimer = null;
    this.reconnectTimer = null;
  }
}
