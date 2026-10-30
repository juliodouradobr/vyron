import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GatewayClose, type ServerMessage } from '@nexo/protocol';
import { bearer, createTestApp, register } from './helpers';

const HEARTBEAT_MS = 300;
let app: FastifyInstance;
let wsUrl: string;

beforeAll(async () => {
  app = await createTestApp({ gateway: { heartbeatIntervalMs: HEARTBEAT_MS, identifyTimeoutMs: 300, offlineGraceMs: 100, maxConnectionsPerUser: 2 } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta');
  wsUrl = `ws://127.0.0.1:${addr.port}/gateway`;
});
afterAll(async () => {
  await app.close();
});

/** Cliente de teste que enfileira mensagens e expõe uma promessa de fechamento. */
function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(wsUrl, { headers });
  const inbox: ServerMessage[] = [];
  const waiters: Array<(m: ServerMessage) => void> = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const next = () => new Promise<ServerMessage>((resolve) => (inbox.length ? resolve(inbox.shift()!) : waiters.push(resolve)));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, next, send, closed };
}

async function identified(token: string) {
  const c = connect();
  expect((await c.next()).op).toBe('hello');
  c.send({ op: 'identify', token });
  const ready = await c.next();
  expect(ready.op).toBe('ready');
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('gateway', () => {
  it('HELLO → IDENTIFY → READY → heartbeat', async () => {
    const { token, user } = await register(app);
    const c = connect();
    const hello = await c.next();
    expect(hello).toEqual({ op: 'hello', heartbeatIntervalMs: HEARTBEAT_MS });
    c.send({ op: 'identify', token });
    const ready = await c.next();
    expect(ready.op === 'ready' && ready.user.id).toBe(user.id);
    c.send({ op: 'heartbeat', seq: 7 });
    expect(await c.next()).toEqual({ op: 'heartbeat_ack', seq: 7 });
    c.ws.close();
  });

  it('fecha com AUTH_FAILED para token inválido', async () => {
    const c = connect();
    await c.next();
    c.send({ op: 'identify', token: 'nx_invalido' });
    expect(await c.closed).toBe(GatewayClose.AUTH_FAILED);
  });

  it('fecha se o cliente não se identificar a tempo', async () => {
    const c = connect();
    expect(await c.closed).toBe(GatewayClose.PROTOCOL_ERROR);
  });

  it('fecha com mensagens fora do protocolo', async () => {
    const c = connect();
    await c.next();
    c.send({ op: 'executar', cmd: 'rm -rf' });
    expect(await c.closed).toBe(GatewayClose.PROTOCOL_ERROR);
  });

  it('exige identify antes de qualquer outra operação', async () => {
    const c = connect();
    await c.next();
    c.send({ op: 'heartbeat', seq: 1 });
    expect(await c.closed).toBe(GatewayClose.PROTOCOL_ERROR);
  });

  it('fecha quando o heartbeat para', async () => {
    const { token } = await register(app);
    const c = await identified(token);
    const started = Date.now();
    expect(await c.closed).toBe(GatewayClose.HEARTBEAT_TIMEOUT);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HEARTBEAT_MS);
  });

  it('derruba a conexão quando a sessão é revogada por outro dispositivo', async () => {
    const a = await register(app);
    const other = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: a.user.username, password: 'senha-muito-segura-1' } })).json();
    const c = await identified(other.token);
    await app.inject({ method: 'DELETE', url: '/api/v1/users/@me/sessions', headers: bearer(a.token) });
    expect(await c.closed).toBe(GatewayClose.SESSION_REVOKED);
  });

  it('limita conexões simultâneas por usuário', async () => {
    const { token } = await register(app);
    const c1 = await identified(token);
    const c2 = await identified(token);
    const c3 = connect();
    await c3.next();
    c3.send({ op: 'identify', token });
    expect(await c3.closed).toBe(GatewayClose.TOO_MANY_CONNECTIONS);
    c1.ws.close();
    c2.ws.close();
  });

  it('rejeita origem não autorizada', async () => {
    const c = connect({ origin: 'https://site-malicioso.example' });
    expect(await c.closed).toBe(GatewayClose.PROTOCOL_ERROR);
  });
});

describe('presença', () => {
  it('fica online com uma ou mais conexões e só fica offline após a última fechar + tolerância', async () => {
    const { token, user } = await register(app);
    const events: string[] = [];
    const off = app.hub.onPresence((id, p) => id === user.id && events.push(p));

    const c1 = await identified(token);
    const c2 = await identified(token);
    expect(app.hub.presenceOf(user.id)).toBe('online');
    c1.ws.close();
    await c1.closed;
    await sleep(150);
    expect(app.hub.presenceOf(user.id)).toBe('online');
    c2.ws.close();
    await c2.closed;
    expect(events).toEqual(['online']);
    await sleep(200);
    expect(events).toEqual(['online', 'offline']);
    off();
  });

  it('reconexão dentro da tolerância não publica offline', async () => {
    const { token, user } = await register(app);
    const events: string[] = [];
    const off = app.hub.onPresence((id, p) => id === user.id && events.push(p));
    const c1 = await identified(token);
    c1.ws.close();
    await c1.closed;
    const c2 = await identified(token);
    await sleep(200);
    expect(events).toEqual(['online']);
    c2.ws.close();
    off();
  });

  it('invisível é publicado como offline e propaga USER_UPDATE para os outros dispositivos', async () => {
    const { token, user } = await register(app);
    const c1 = await identified(token);
    const c2 = await identified(token);
    c1.send({ op: 'set_status', status: 'invisible' });
    const ev = await c2.next();
    expect(ev.op === 'dispatch' && ev.event.type === 'USER_UPDATE' && ev.event.user.status).toBe('invisible');
    expect(app.hub.presenceOf(user.id)).toBe('offline');
    c1.ws.close();
    c2.ws.close();
  });
});
