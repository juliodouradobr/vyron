import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient, READY_TIMEOUT_MS, backoffDelay, type GatewayCallbacks } from './gateway';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

function setup() {
  const cb: GatewayCallbacks = { onState: vi.fn(), onReady: vi.fn(), onDispatch: vi.fn(), onFatal: vi.fn(), onLatency: vi.fn() };
  const client = new GatewayClient({
    url: 'ws://teste',
    getToken: () => 'nx_token',
    callbacks: cb,
    createSocket: () => new FakeSocket() as never,
    random: () => 0.5,
  });
  return { client, cb };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe('backoffDelay', () => {
  it('cresce exponencialmente com teto de 30s', () => {
    const r = () => 1;
    expect(backoffDelay(0, r)).toBe(1000);
    expect(backoffDelay(1, r)).toBe(2000);
    expect(backoffDelay(3, r)).toBe(8000);
    expect(backoffDelay(10, r)).toBe(30000);
    expect(backoffDelay(0, () => 0)).toBe(500);
  });
});

describe('GatewayClient', () => {
  it('identifica após HELLO e informa READY', () => {
    const { client, cb } = setup();
    client.start();
    const s = FakeSocket.all[0]!;
    s.receive({ op: 'hello', heartbeatIntervalMs: 1000 });
    expect(s.sent[0]).toEqual({ op: 'identify', token: 'nx_token' });
    s.receive({ op: 'ready', user: { id: 'u1' }, sessionId: 's1' });
    expect(cb.onReady).toHaveBeenCalledWith({ id: 'u1' }, 's1');
    expect(cb.onState).toHaveBeenLastCalledWith('connected');
    client.stop();
  });

  it('envia heartbeats e mede a latência pelo ACK', () => {
    const { client, cb } = setup();
    client.start();
    const s = FakeSocket.all[0]!;
    s.receive({ op: 'hello', heartbeatIntervalMs: 1000 });
    vi.advanceTimersByTime(50);
    expect(s.sent[1]).toEqual({ op: 'heartbeat', seq: 1 });
    vi.advanceTimersByTime(40);
    s.receive({ op: 'heartbeat_ack', seq: 1 });
    expect(cb.onLatency).toHaveBeenCalledWith(40);
    client.stop();
  });

  it('considera a conexão morta se o ACK não chegar e reconecta com backoff', () => {
    const { client, cb } = setup();
    client.start();
    const s = FakeSocket.all[0]!;
    s.receive({ op: 'hello', heartbeatIntervalMs: 1000 });
    vi.advanceTimersByTime(50); // heartbeat 1, sem ACK
    vi.advanceTimersByTime(1000); // próximo ciclo detecta zumbi
    expect(s.readyState).toBe(3);
    expect(cb.onState).toHaveBeenLastCalledWith('reconnecting', { retryInMs: 750 });
    vi.advanceTimersByTime(750);
    expect(FakeSocket.all).toHaveLength(2);
    client.stop();
  });

  it('não reconecta quando a sessão foi revogada', () => {
    const { client, cb } = setup();
    client.start();
    FakeSocket.all[0]!.close(4005);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(cb.onFatal).toHaveBeenCalledWith(4005);
  });

  it('stop() encerra sem disparar reconexão', () => {
    const { client } = setup();
    client.start();
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('refaz a conexão se o handshake não chegar ao READY a tempo', () => {
    const { client, cb } = setup();
    client.start();
    FakeSocket.all[0]!.receive({ op: 'hello', heartbeatIntervalMs: 60_000 });
    // O servidor nunca responde ao identify.
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(FakeSocket.all[0]!.readyState).toBe(3);
    expect(cb.onState).toHaveBeenLastCalledWith('reconnecting', { retryInMs: 750 });
    vi.advanceTimersByTime(750);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.receive({ op: 'hello', heartbeatIntervalMs: 60_000 });
    FakeSocket.all[1]!.receive({ op: 'ready', user: { id: 'u1' }, sessionId: 's1' });
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
    expect(FakeSocket.all[1]!.readyState).toBe(1);
    client.stop();
  });

  it('reconnectNow() antecipa a tentativa agendada', () => {
    const { client } = setup();
    client.start();
    FakeSocket.all[0]!.close(1006);
    client.reconnectNow();
    expect(FakeSocket.all).toHaveLength(2);
    client.stop();
  });
});
