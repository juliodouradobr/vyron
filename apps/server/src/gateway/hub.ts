import type { PresenceStatus, ServerMessage } from '@nexo/protocol';

export type PublicPresence = PresenceStatus | 'offline';

export interface Connection {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

type PresenceListener = (userId: string, presence: PublicPresence) => void;

/**
 * Registro de conexões do gateway e fonte de verdade da presença.
 *
 * Um usuário pode ter várias conexões (vários dispositivos). Ele é anunciado online na
 * primeira conexão e offline somente quando a última fecha e o período de tolerância passa,
 * para que uma reconexão rápida não gere "piscadas" de presença.
 * Status "invisible" é publicado como "offline" — o servidor continua sabendo que há conexão.
 */
export class Hub {
  private readonly byUser = new Map<string, Map<string, Connection>>();
  private readonly byId = new Map<string, Connection>();
  private readonly closeListeners = new Set<(conn: Connection) => void>();
  private readonly status = new Map<string, PresenceStatus>();
  private readonly published = new Map<string, PublicPresence>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<PresenceListener>();

  constructor(private readonly offlineGraceMs: number) {}

  connectionCount(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  add(conn: Connection, status: PresenceStatus): void {
    let conns = this.byUser.get(conn.userId);
    if (!conns) this.byUser.set(conn.userId, (conns = new Map()));
    conns.set(conn.id, conn);
    this.byId.set(conn.id, conn);
    clearTimeout(this.offlineTimers.get(conn.userId));
    this.offlineTimers.delete(conn.userId);
    this.status.set(conn.userId, status);
    this.publish(conn.userId);
  }

  remove(conn: Connection): void {
    if (this.byId.delete(conn.id)) for (const fn of this.closeListeners) fn(conn);
    const conns = this.byUser.get(conn.userId);
    if (!conns?.delete(conn.id) || conns.size > 0) return;
    this.byUser.delete(conn.userId);
    clearTimeout(this.offlineTimers.get(conn.userId));
    this.offlineTimers.set(
      conn.userId,
      setTimeout(() => {
        this.offlineTimers.delete(conn.userId);
        if (this.connectionCount(conn.userId) === 0) this.publish(conn.userId);
      }, this.offlineGraceMs),
    );
  }

  setStatus(userId: string, status: PresenceStatus): void {
    this.status.set(userId, status);
    this.publish(userId);
  }

  /** Presença que outros usuários podem ver. */
  presenceOf(userId: string): PublicPresence {
    if (this.connectionCount(userId) === 0) return 'offline';
    const s = this.status.get(userId) ?? 'online';
    return s === 'invisible' ? 'offline' : s;
  }

  /** Envia a uma conexão específica (ex.: o dispositivo que está na chamada). */
  sendToConnection(connId: string, msg: ServerMessage): void {
    this.byId.get(connId)?.send(msg);
  }

  /** Avisa quando uma conexão fecha — usado para tirar o dispositivo da chamada. */
  onConnectionClosed(fn: (conn: Connection) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  sendToUser(userId: string, msg: ServerMessage): void {
    for (const c of this.byUser.get(userId)?.values() ?? []) c.send(msg);
  }

  /** Fecha imediatamente as conexões ligadas às sessões revogadas. */
  closeSessions(sessionIds: Iterable<string>, code: number, reason: string): void {
    const ids = new Set(sessionIds);
    if (ids.size === 0) return;
    for (const conns of this.byUser.values()) {
      for (const c of [...conns.values()]) if (ids.has(c.sessionId)) c.close(code, reason);
    }
  }

  onPresence(fn: PresenceListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish(userId: string): void {
    const p = this.presenceOf(userId);
    if (this.published.get(userId) === p) return;
    if (p === 'offline') this.published.delete(userId);
    else this.published.set(userId, p);
    for (const fn of this.listeners) fn(userId, p);
  }

  shutdown(): void {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
    for (const conns of this.byUser.values()) for (const c of conns.values()) c.close(1001, 'servidor encerrando');
  }
}
