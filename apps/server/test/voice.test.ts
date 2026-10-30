import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Permission as P, type DispatchEvent, type ServerDetail, type ServerMessage } from '@nexo/protocol';
import { turnCredential } from '../src/voice/service';
import { befriend, createTestApp, user, type TestUser } from './helpers';

let app: FastifyInstance;
let wsUrl: string;
beforeAll(async () => {
  app = await createTestApp({ voice: { stunUrls: ['stun:stun.exemplo:3478'], turnUrls: ['turn:turn.exemplo:3478'], turnSecret: 'segredo-de-teste', turnTtlSeconds: 3600 } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta');
  wsUrl = `ws://127.0.0.1:${addr.port}/gateway`;
});
afterAll(async () => {
  await app.close();
});

/** Cliente de gateway que registra eventos e espera por um em particular. */
function gw(token: string) {
  const ws = new WebSocket(wsUrl);
  const events: DispatchEvent[] = [];
  const waiters: Array<{ pred: (e: DispatchEvent) => boolean; resolve: (e: DispatchEvent) => void }> = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.op === 'hello') ws.send(JSON.stringify({ op: 'identify', token }));
      if (m.op === 'ready') resolve();
      if (m.op !== 'dispatch') return;
      events.push(m.event);
      for (const w of [...waiters]) if (w.pred(m.event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m.event); }
    });
  });
  const waitFor = <T extends DispatchEvent['type']>(type: T, pred: (e: Extract<DispatchEvent, { type: T }>) => boolean = () => true, ms = 2000) =>
    new Promise<Extract<DispatchEvent, { type: T }>>((resolve, reject) => {
      const hit = events.find((e) => e.type === type && pred(e as never));
      if (hit) return resolve(hit as never);
      const t = setTimeout(() => reject(new Error(`timeout esperando ${type}`)), ms);
      waiters.push({ pred: (e) => e.type === type && pred(e as never), resolve: (e) => { clearTimeout(t); resolve(e as never); } });
    });
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  return { ws, events, ready, waitFor, closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function voiceSetup() {
  const owner = await user(app);
  const member = await user(app);
  const outsider = await user(app);
  const d = (await owner.post('/servers', { name: 'Voz' })).body as ServerDetail;
  const code = (await owner.post(`/servers/${d.server.id}/invites`, {})).body.code;
  await member.post(`/invites/${code}`);
  const voice = d.channels.find((c) => c.type === 'voice')!;
  const text = d.channels.find((c) => c.type === 'text')!;
  const everyone = d.roles.find((r) => r.isDefault)!;
  return { owner, member, outsider, d, voice, text, everyone, sid: d.server.id };
}

describe('canais de voz', () => {
  it('entrar envia READY com ICE/TURN temporário e avisa só quem vê o canal', async () => {
    const { owner, member, outsider, voice } = await voiceSetup();
    const go = gw(owner.token), gm = gw(member.token), gx = gw(outsider.token);
    await Promise.all([go.ready, gm.ready, gx.ready]);

    go.send({ op: 'voice_join', channelId: voice.id });
    const ready = await go.waitFor('VOICE_READY');
    expect(ready.participants.map((p) => p.userId)).toEqual([owner.id]);
    expect(ready.relayAvailable).toBe(true);
    expect(ready.iceServers[0]).toEqual({ urls: ['stun:stun.exemplo:3478'] });
    const turn = ready.iceServers[1]!;
    expect(turn.username).toMatch(new RegExp(`^\\d+:${owner.id}$`));
    expect(turn.credential).toBe(createHmac('sha1', 'segredo-de-teste').update(turn.username!).digest('base64'));
    expect(JSON.stringify(ready)).not.toContain('segredo-de-teste');

    const upd = await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === owner.id);
    expect(upd.state).toMatchObject({ selfMute: false, suppressed: false });
    await sleep(100);
    expect(gx.events.filter((e) => e.type.startsWith('VOICE'))).toEqual([]);
    for (const c of [go, gm, gx]) c.ws.close();
  });

  it('sem CONNECT_VOICE recusa; sem SPEAK entra suprimido; canal de texto não é voz', async () => {
    const { owner, member, voice, text, everyone } = await voiceSetup();
    const gm = gw(member.token);
    await gm.ready;
    gm.send({ op: 'voice_join', channelId: text.id });
    expect((await gm.waitFor('VOICE_ERROR')).code).toBe('NOT_FOUND');

    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.SPEAK.toString() });
    gm.send({ op: 'voice_join', channelId: voice.id });
    const ready = await gm.waitFor('VOICE_READY');
    expect(ready.participants[0]).toMatchObject({ userId: member.id, suppressed: true });
    gm.send({ op: 'voice_leave' });
    await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.state === null);

    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.CONNECT_VOICE.toString() });
    gm.send({ op: 'voice_join', channelId: voice.id });
    expect((await gm.waitFor('VOICE_ERROR', (e) => e.code === 'FORBIDDEN')).message).toMatch(/permissão/);
    gm.ws.close();
  });

  it('não-membro não entra em canal de voz alheio', async () => {
    const { outsider, voice } = await voiceSetup();
    const gx = gw(outsider.token);
    await gx.ready;
    gx.send({ op: 'voice_join', channelId: voice.id });
    expect((await gx.waitFor('VOICE_ERROR')).code).toBe('NOT_FOUND');
    gx.ws.close();
  });

  it('sinalização só é retransmitida entre pessoas da mesma sala, com remetente carimbado pelo servidor', async () => {
    const { owner, member, voice, sid } = await voiceSetup();
    const third = await user(app);
    await third.post(`/invites/${(await owner.post(`/servers/${sid}/invites`, {})).body.code}`);
    const go = gw(owner.token), gm = gw(member.token), gt = gw(third.token);
    await Promise.all([go.ready, gm.ready, gt.ready]);
    go.send({ op: 'voice_join', channelId: voice.id });
    gm.send({ op: 'voice_join', channelId: voice.id });
    await go.waitFor('VOICE_READY');
    await gm.waitFor('VOICE_READY');

    const offer = { kind: 'description', description: { type: 'offer', sdp: 'v=0 teste' } };
    gm.send({ op: 'voice_signal', to: owner.id, signal: offer });
    const got = await go.waitFor('VOICE_SIGNAL');
    expect(got).toMatchObject({ from: member.id, signal: offer });

    // Quem não está na sala não consegue mandar nada para quem está.
    gt.send({ op: 'voice_signal', to: owner.id, signal: offer });
    await sleep(150);
    expect(go.events.filter((e) => e.type === 'VOICE_SIGNAL')).toHaveLength(1);
    for (const c of [go, gm, gt]) c.ws.close();
  });

  it('queda da conexão tira da sala; entrar em outra sala sai da anterior', async () => {
    const { owner, member, voice, sid } = await voiceSetup();
    const go = gw(owner.token), gm = gw(member.token);
    await Promise.all([go.ready, gm.ready]);
    gm.send({ op: 'voice_join', channelId: voice.id });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state);
    gm.ws.close();
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && e.state === null);
    expect(app.voice.channelOf(member.id)).toBeUndefined();

    const other = (await owner.post(`/servers/${sid}/channels`, { name: 'Sala 2', type: 'voice' })).body;
    go.send({ op: 'voice_join', channelId: voice.id });
    await go.waitFor('VOICE_READY', (e) => e.channelId === voice.id);
    go.send({ op: 'voice_join', channelId: other.id });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.channelId === voice.id && e.state === null);
    await go.waitFor('VOICE_READY', (e) => e.channelId === other.id);
    expect(app.voice.channelOf(owner.id)).toBe(other.id);
    expect(app.voice.participants(voice.id)).toEqual([]);
    go.ws.close();
  });

  it('retirar a permissão ou expulsar tira a pessoa da chamada na hora', async () => {
    const { owner, member, voice, everyone, sid } = await voiceSetup();
    const gm = gw(member.token);
    await gm.ready;
    gm.send({ op: 'voice_join', channelId: voice.id });
    await gm.waitFor('VOICE_READY');
    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.SPEAK.toString() });
    expect((await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.suppressed)).state!.suppressed).toBe(true);

    await owner.del(`/servers/${sid}/members/${member.id}`);
    await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && e.state === null);
    expect(app.voice.channelOf(member.id)).toBeUndefined();
    gm.ws.close();
  });

  it('estado de microfone propaga e ensurdecer implica silenciar', async () => {
    const { owner, member, voice } = await voiceSetup();
    const go = gw(owner.token), gm = gw(member.token);
    await Promise.all([go.ready, gm.ready]);
    gm.send({ op: 'voice_join', channelId: voice.id });
    await gm.waitFor('VOICE_READY');
    gm.send({ op: 'voice_state', selfMute: false, selfDeaf: true });
    const e = await go.waitFor('VOICE_STATE_UPDATE', (x) => !!x.state?.selfDeaf);
    expect(e.state).toMatchObject({ selfMute: true, selfDeaf: true });
    for (const c of [go, gm]) c.ws.close();
  });

  it('GET /voice/states mostra só salas visíveis', async () => {
    const { owner, member, outsider, voice } = await voiceSetup();
    const go = gw(owner.token);
    await go.ready;
    go.send({ op: 'voice_join', channelId: voice.id });
    await go.waitFor('VOICE_READY');
    expect((await member.get('/voice/states')).body[voice.id]).toEqual([expect.objectContaining({ userId: owner.id })]);
    expect((await outsider.get('/voice/states')).body[voice.id]).toBeUndefined();
    go.ws.close();
  });
});

describe('transmissão de tela', () => {
  async function inRoom() {
    const s = await voiceSetup();
    const go = gw(s.owner.token), gm = gw(s.member.token);
    await Promise.all([go.ready, gm.ready]);
    go.send({ op: 'voice_join', channelId: s.voice.id });
    await go.waitFor('VOICE_READY');
    gm.send({ op: 'voice_join', channelId: s.voice.id });
    await gm.waitFor('VOICE_READY');
    return { ...s, go, gm };
  }

  it('começar anuncia a transmissão; assistir entra na lista; parar limpa', async () => {
    const { owner, member, go, gm } = await inRoom();
    gm.send({ op: 'stream_start', surface: 'window', hasAudio: true, streamId: '{3f2a0c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b}' });
    const started = await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.stream);
    expect(started.state!.stream).toMatchObject({ surface: 'window', hasAudio: true, viewers: [], streamId: '{3f2a0c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b}' });

    go.send({ op: 'stream_watch', userId: member.id, watching: true });
    const watched = await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.stream?.viewers.length);
    expect(watched.state!.stream!.viewers).toEqual([owner.id]);

    go.send({ op: 'stream_watch', userId: member.id, watching: false });
    await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && e.state?.stream?.viewers.length === 0);

    gm.send({ op: 'stream_stop' });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state && e.state.stream === null);
    for (const c of [go, gm]) c.ws.close();
  });

  it('sem a permissão STREAM recusa e não anuncia nada', async () => {
    const { owner, member, voice, everyone, go, gm } = await inRoom();
    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.STREAM.toString() });
    gm.send({ op: 'stream_start', surface: 'monitor', hasAudio: false, streamId: '{3f2a0c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b}' });
    expect((await gm.waitFor('STREAM_ERROR')).message).toMatch(/permissão/);
    await sleep(100);
    expect(go.events.some((e) => e.type === 'VOICE_STATE_UPDATE' && !!e.state?.stream)).toBe(false);
    for (const c of [go, gm]) c.ws.close();
  });

  it('perder STREAM durante a transmissão encerra a transmissão na hora', async () => {
    const { owner, member, voice, everyone, go, gm } = await inRoom();
    gm.send({ op: 'stream_start', surface: 'monitor', hasAudio: false, streamId: '{3f2a0c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b}' });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.stream);
    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.STREAM.toString() });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state && e.state.stream === null);
    for (const c of [go, gm]) c.ws.close();
  });

  it('não dá para assistir quem não transmite nem de fora da sala; sair da sala deixa de assistir', async () => {
    const { member, outsider, voice, go, gm } = await inRoom();
    go.send({ op: 'stream_watch', userId: member.id, watching: true });
    expect((await go.waitFor('STREAM_ERROR')).message).toMatch(/terminou/);

    gm.send({ op: 'stream_start', surface: 'browser', hasAudio: false, streamId: '{3f2a0c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b}' });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.stream);
    const gx = gw(outsider.token);
    await gx.ready;
    gx.send({ op: 'stream_watch', userId: member.id, watching: true });
    await sleep(100);
    expect(app.voice.participants(voice.id).find((p) => p.userId === member.id)!.stream!.viewers).toEqual([]);

    go.send({ op: 'stream_watch', userId: member.id, watching: true });
    await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && e.state?.stream?.viewers.length === 1);
    go.send({ op: 'voice_leave' });
    await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && e.state?.stream?.viewers.length === 0);
    for (const c of [go, gm, gx]) c.ws.close();
  });

  it('em chamada privada, os dois podem transmitir', async () => {
    const a = await user(app);
    const b = await user(app);
    await befriend(a, b);
    const dm = (await a.post('/users/@me/channels', { recipientId: b.id })).body;
    const ga = gw(a.token), gb = gw(b.token);
    await Promise.all([ga.ready, gb.ready]);
    ga.send({ op: 'voice_join', channelId: dm.id });
    await ga.waitFor('VOICE_READY');
    gb.send({ op: 'voice_join', channelId: dm.id });
    await gb.waitFor('VOICE_READY');
    ga.send({ op: 'stream_start', surface: 'monitor', hasAudio: false, streamId: '{3f2a0c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b}' });
    await gb.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === a.id && !!e.state?.stream);
    for (const c of [ga, gb]) c.ws.close();
  });
});

describe('câmera', () => {
  async function inRoom() {
    const s = await voiceSetup();
    const go = gw(s.owner.token), gm = gw(s.member.token);
    await Promise.all([go.ready, gm.ready]);
    go.send({ op: 'voice_join', channelId: s.voice.id });
    await go.waitFor('VOICE_READY');
    gm.send({ op: 'voice_join', channelId: s.voice.id });
    await gm.waitFor('VOICE_READY');
    return { ...s, go, gm };
  }

  it('ligar anuncia a câmera com o id da mídia; desligar limpa', async () => {
    const { member, go, gm } = await inRoom();
    gm.send({ op: 'camera_on', streamId: 'cam-1234' });
    const on = await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.camera);
    expect(on.state!.camera).toMatchObject({ streamId: 'cam-1234' });
    gm.send({ op: 'camera_off' });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state && e.state.camera === null);
    for (const c of [go, gm]) c.ws.close();
  });

  it('sem VIDEO recusa a câmera mas a tela (STREAM) continua permitida', async () => {
    const { owner, member, voice, everyone, go, gm } = await inRoom();
    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.VIDEO.toString() });
    gm.send({ op: 'camera_on', streamId: 'cam-1' });
    const err = await gm.waitFor('STREAM_ERROR');
    expect(err).toMatchObject({ kind: 'camera' });
    expect(err.message).toMatch(/câmera/);
    gm.send({ op: 'stream_start', surface: 'monitor', hasAudio: false, streamId: 'scr-1' });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.stream);
    expect(go.events.some((e) => e.type === 'VOICE_STATE_UPDATE' && !!e.state?.camera)).toBe(false);
    for (const c of [go, gm]) c.ws.close();
  });

  it('perder VIDEO durante a chamada desliga a câmera na hora', async () => {
    const { owner, member, voice, everyone, go, gm } = await inRoom();
    gm.send({ op: 'camera_on', streamId: 'cam-1' });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state?.camera);
    await owner.put(`/channels/${voice.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.VIDEO.toString() });
    await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === member.id && !!e.state && e.state.camera === null);
    for (const c of [go, gm]) c.ws.close();
  });

  it('recusa ids de mídia malformados (fecha a conexão por protocolo)', async () => {
    const { gm } = await inRoom();
    gm.send({ op: 'camera_on', streamId: '<script>' });
    await gm.closed;
  });
});

describe('Jogar Juntos', () => {
  /** owner transmite; member assiste (ou não). */
  async function playRoom(watch = true) {
    const s = await voiceSetup();
    const go = gw(s.owner.token), gm = gw(s.member.token);
    await Promise.all([go.ready, gm.ready]);
    go.send({ op: 'voice_join', channelId: s.voice.id });
    await go.waitFor('VOICE_READY');
    gm.send({ op: 'voice_join', channelId: s.voice.id });
    await gm.waitFor('VOICE_READY');
    go.send({ op: 'stream_start', surface: 'window', hasAudio: false, streamId: 'scr-1' });
    await gm.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === s.owner.id && !!e.state?.stream);
    if (watch) {
      gm.send({ op: 'stream_watch', userId: s.owner.id, watching: true });
      await go.waitFor('VOICE_STATE_UPDATE', (e) => e.userId === s.owner.id && !!e.state?.stream?.viewers.length);
    }
    const control = () => app.voice.participants(s.voice.id).find((p) => p.userId === s.owner.id)?.stream?.control ?? null;
    return { ...s, go, gm, control };
  }
  const grant = { keyboard: true, mouse: true, gamepad: false, minutes: 30 };

  it('assistir não dá controle; pedir só avisa o dono; conceder anuncia quem controla e o que pode', async () => {
    const { owner, member, go, gm, control } = await playRoom();
    expect(control()).toBeNull();
    gm.send({ op: 'play_request', hostId: owner.id });
    expect(await go.waitFor('PLAY_REQUEST')).toMatchObject({ from: member.id });
    expect(gm.events.some((e) => e.type === 'PLAY_REQUEST')).toBe(false);
    expect(control()).toBeNull();

    go.send({ op: 'play_grant', guestId: member.id, ...grant });
    const e = await gm.waitFor('VOICE_STATE_UPDATE', (x) => !!x.state?.stream?.control);
    expect(e.state!.stream!.control).toMatchObject({ guestId: member.id, keyboard: true, mouse: true, gamepad: false });
    const ms = Date.parse(e.state!.stream!.control!.expiresAt) - Date.parse(e.state!.stream!.control!.grantedAt);
    expect(ms).toBe(30 * 60_000);
    for (const c of [go, gm]) c.ws.close();
  });

  it('só o dono concede, e só para quem está assistindo', async () => {
    const { owner, member, go, gm, control } = await playRoom(false);
    go.send({ op: 'play_grant', guestId: member.id, ...grant });
    expect((await go.waitFor('STREAM_ERROR')).message).toMatch(/assistindo/);
    // Quem não transmite não consegue conceder controle de nada (nem sobre a tela de outra pessoa).
    gm.send({ op: 'play_grant', guestId: owner.id, ...grant });
    await sleep(100);
    expect(control()).toBeNull();
    // Pedir sem assistir é recusado.
    gm.send({ op: 'play_request', hostId: owner.id });
    expect((await gm.waitFor('STREAM_ERROR')).message).toMatch(/assista/);
    for (const c of [go, gm]) c.ws.close();
  });

  it('revogar, devolver, parar de assistir, sair ou parar a transmissão tiram o controle na hora', async () => {
    const { owner, member, go, gm, control } = await playRoom();
    const granted = async () => {
      go.send({ op: 'play_grant', guestId: member.id, ...grant });
      await gm.waitFor('VOICE_STATE_UPDATE', (x) => !!x.state?.stream?.control);
      gm.events.length = 0;
    };
    const cleared = () => gm.waitFor('VOICE_STATE_UPDATE', (x) => x.userId === owner.id && !!x.state?.stream && x.state.stream.control === null);

    await granted();
    go.send({ op: 'play_revoke' });
    await cleared();

    await granted();
    gm.send({ op: 'play_release', hostId: owner.id });
    await cleared();

    await granted();
    gm.send({ op: 'stream_watch', userId: owner.id, watching: false });
    await cleared();
    expect(control()).toBeNull();

    gm.send({ op: 'stream_watch', userId: owner.id, watching: true });
    await go.waitFor('VOICE_STATE_UPDATE', (x) => x.userId === owner.id && x.state?.stream?.viewers.length === 1);
    await granted();
    go.send({ op: 'stream_stop' });
    await gm.waitFor('VOICE_STATE_UPDATE', (x) => x.userId === owner.id && !!x.state && x.state.stream === null);
    expect(control()).toBeNull();
    for (const c of [go, gm]) c.ws.close();
  });

  it('quem controla sai da sala: controle removido', async () => {
    const { owner, member, go, gm, control } = await playRoom();
    go.send({ op: 'play_grant', guestId: member.id, ...grant });
    await gm.waitFor('VOICE_STATE_UPDATE', (x) => !!x.state?.stream?.control);
    await go.waitFor('VOICE_STATE_UPDATE', (x) => !!x.state?.stream?.control);
    go.events.length = 0;
    gm.send({ op: 'voice_leave' });
    await go.waitFor('VOICE_STATE_UPDATE', (x) => x.userId === owner.id && !!x.state?.stream && x.state.stream.control === null);
    expect(control()).toBeNull();
    for (const c of [go, gm]) c.ws.close();
  });

  it('exige ao menos um tipo de entrada; prazo fora de 1–120 min fecha a conexão por protocolo', async () => {
    const { member, go, control } = await playRoom();
    go.send({ op: 'play_grant', guestId: member.id, keyboard: false, mouse: false, gamepad: false, minutes: 10 });
    expect((await go.waitFor('STREAM_ERROR')).message).toMatch(/ao menos um/);
    expect(control()).toBeNull();
    go.send({ op: 'play_grant', guestId: member.id, ...grant, minutes: 500 });
    await go.closed;
  });

  it('pedidos repetidos em sequência são limitados', async () => {
    const { owner, gm, go } = await playRoom();
    gm.send({ op: 'play_request', hostId: owner.id });
    await go.waitFor('PLAY_REQUEST');
    gm.send({ op: 'play_request', hostId: owner.id });
    expect((await gm.waitFor('STREAM_ERROR')).message).toMatch(/Aguarde/);
    expect(go.events.filter((e) => e.type === 'PLAY_REQUEST')).toHaveLength(1);
    for (const c of [go, gm]) c.ws.close();
  });

  it('o controle expira sozinho no prazo concedido', async () => {
    const { owner, member, go, gm, control } = await playRoom();
    const real = globalThis.setTimeout;
    let expire: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 30 * 60_000) {
        expire = fn;
        return real(() => {}, 0);
      }
      return real(fn, ms);
    }) as typeof setTimeout);
    go.send({ op: 'play_grant', guestId: member.id, ...grant });
    await gm.waitFor('VOICE_STATE_UPDATE', (x) => !!x.state?.stream?.control);
    spy.mockRestore();
    expect(expire).not.toBeNull();
    gm.events.length = 0;
    expire!();
    await gm.waitFor('VOICE_STATE_UPDATE', (x) => x.userId === owner.id && !!x.state?.stream && x.state.stream.control === null);
    expect(control()).toBeNull();
    for (const c of [go, gm]) c.ws.close();
  });

  it('recusar avisa só quem pediu', async () => {
    const { owner, member, go, gm } = await playRoom();
    go.send({ op: 'play_decline', guestId: member.id });
    expect(await gm.waitFor('PLAY_DECLINED')).toMatchObject({ hostId: owner.id });
    for (const c of [go, gm]) c.ws.close();
  });
});

describe('chamadas privadas', () => {
  async function pair(): Promise<[TestUser, TestUser, string]> {
    const a = await user(app);
    const b = await user(app);
    await befriend(a, b);
    const dm = (await a.post('/users/@me/channels', { recipientId: b.id })).body;
    return [a, b, dm.id];
  }

  it('tocar avisa o outro lado; recusar avisa quem ligou sem abrir mídia', async () => {
    const [a, b, dmId] = await pair();
    const ga = gw(a.token), gb = gw(b.token);
    await Promise.all([ga.ready, gb.ready]);
    ga.send({ op: 'voice_join', channelId: dmId });
    await ga.waitFor('VOICE_READY');
    ga.send({ op: 'call_ring', channelId: dmId });
    expect(await gb.waitFor('CALL_RING')).toMatchObject({ channelId: dmId, from: a.id });
    gb.send({ op: 'call_decline', channelId: dmId });
    expect(await ga.waitFor('CALL_DECLINE')).toMatchObject({ userId: b.id });
    expect(gb.events.some((e) => e.type === 'VOICE_READY')).toBe(false);
    expect(app.voice.channelOf(b.id)).toBeUndefined();
    for (const c of [ga, gb]) c.ws.close();
  });

  it('aceitar = entrar na sala da DM; os dois se veem', async () => {
    const [a, b, dmId] = await pair();
    const ga = gw(a.token), gb = gw(b.token);
    await Promise.all([ga.ready, gb.ready]);
    ga.send({ op: 'voice_join', channelId: dmId });
    await ga.waitFor('VOICE_READY');
    gb.send({ op: 'voice_join', channelId: dmId });
    const ready = await gb.waitFor('VOICE_READY');
    expect(ready.participants.map((p) => p.userId).sort()).toEqual([a.id, b.id].sort());
    for (const c of [ga, gb]) c.ws.close();
  });

  it('bloqueio impede a chamada', async () => {
    const [a, b, dmId] = await pair();
    await b.put(`/users/@me/relationships/${a.id}/block`);
    const ga = gw(a.token);
    await ga.ready;
    ga.send({ op: 'voice_join', channelId: dmId });
    expect((await ga.waitFor('VOICE_ERROR')).code).toBe('BLOCKED');
    ga.ws.close();
  });
});

describe('turnCredential', () => {
  it('segue o formato da TURN REST API e expira', () => {
    const c = turnCredential('s3gredo', 'user-1', 600, 1_700_000_000_000);
    expect(c.username).toBe('1700000600:user-1');
    expect(c.credential).toBe(createHmac('sha1', 's3gredo').update('1700000600:user-1').digest('base64'));
  });
});
