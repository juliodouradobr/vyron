import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, Permission as P, type ServerDetail, type ServerMessage } from '@nexo/protocol';
import { createTestApp, user, type TestUser } from './helpers';

let app: FastifyInstance;
let wsUrl: string;
beforeAll(async () => {
  app = await createTestApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta');
  wsUrl = `ws://127.0.0.1:${addr.port}/gateway`;
});
afterAll(async () => {
  await app.close();
});

const p = (bits: bigint) => bits.toString();

/** Servidor com dono, um moderador (MANAGE_ROLES + KICK + MANAGE_MESSAGES) e um membro comum. */
async function setup() {
  const owner = await user(app);
  const mod = await user(app);
  const member = await user(app);
  const created = await owner.post('/servers', { name: 'Clã Teste' });
  const detail = created.body as ServerDetail;
  const sid = detail.server.id;
  const code = (await owner.post(`/servers/${sid}/invites`, {})).body.code;
  await mod.post(`/invites/${code}`);
  await member.post(`/invites/${code}`);
  const modRole = (
    await owner.post(`/servers/${sid}/roles`, { name: 'Mod', permissions: p(P.MANAGE_ROLES | P.KICK_MEMBERS | P.MANAGE_MESSAGES | P.MANAGE_CHANNELS) })
  ).body;
  await owner.put(`/servers/${sid}/members/${mod.id}/roles`, { roleIds: [modRole.id] });
  const general = detail.channels.find((c) => c.name === 'geral')!;
  return { owner, mod, member, sid, detail, modRole, general, code };
}

function listen(token: string) {
  const ws = new WebSocket(wsUrl);
  const events: Array<Extract<ServerMessage, { op: 'dispatch' }>['event']> = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.op === 'hello') ws.send(JSON.stringify({ op: 'identify', token }));
      if (m.op === 'ready') resolve();
      if (m.op === 'dispatch') events.push(m.event);
    });
  });
  return { ws, events, ready, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('servidores', () => {
  it('cria com @everyone, categorias e canais padrão; dono tem todas as permissões', async () => {
    const owner = await user(app);
    const res = await owner.post('/servers', { name: 'Meu servidor' });
    expect(res.status).toBe(201);
    const d = res.body as ServerDetail;
    expect(d.roles).toEqual([expect.objectContaining({ name: '@everyone', isDefault: true, permissions: p(DEFAULT_EVERYONE_PERMISSIONS) })]);
    expect(d.channels.map((c) => [c.type, c.name]).sort()).toEqual([
      ['category', 'Canais de texto'],
      ['category', 'Canais de voz'],
      ['text', 'geral'],
      ['voice', 'Geral'],
    ]);
    expect(d.myPermissions).toBe(p(ALL_PERMISSIONS));
    expect((await owner.get('/users/@me/servers')).body).toHaveLength(1);
  });

  it('não-membros recebem 404 em servidor, canais e mensagens', async () => {
    const { sid, general } = await setup();
    const outsider = await user(app);
    expect((await outsider.get(`/servers/${sid}`)).status).toBe(404);
    expect((await outsider.get(`/servers/${sid}/members`)).status).toBe(404);
    expect((await outsider.get(`/channels/${general.id}/messages`)).status).toBe(404);
    expect((await outsider.post(`/channels/${general.id}/messages`, { content: 'oi' })).status).toBe(404);
    expect((await outsider.post(`/servers/${sid}/invites`, {})).status).toBe(404);
  });

  it('membro comum não gerencia nada', async () => {
    const { member, sid, general, modRole } = await setup();
    expect((await member.patch(`/servers/${sid}`, { name: 'Hackeado' })).status).toBe(403);
    expect((await member.post(`/servers/${sid}/channels`, { name: 'x', type: 'text' })).status).toBe(403);
    expect((await member.del(`/channels/${general.id}`)).status).toBe(403);
    expect((await member.post(`/servers/${sid}/roles`, { name: 'Eu' })).status).toBe(403);
    expect((await member.put(`/servers/${sid}/members/${member.id}/roles`, { roleIds: [modRole.id] })).status).toBe(403);
    expect((await member.get(`/servers/${sid}/audit-log`)).status).toBe(403);
    expect((await member.del(`/servers/${sid}`)).status).toBe(403);
  });
});

describe('anti-escalonamento de permissões', () => {
  it('moderador não cria cargo com permissão que não tem', async () => {
    const { mod, sid } = await setup();
    const res = await mod.post(`/servers/${sid}/roles`, { name: 'Admin falso', permissions: p(P.ADMINISTRATOR) });
    expect(res.status).toBe(403);
    expect((await mod.post(`/servers/${sid}/roles`, { name: 'Ajudante', permissions: p(P.KICK_MEMBERS) })).status).toBe(201);
  });

  it('moderador não edita o próprio cargo (autopromoção) nem cargos acima', async () => {
    const { mod, sid, modRole } = await setup();
    expect((await mod.patch(`/servers/${sid}/roles/${modRole.id}`, { permissions: p(ALL_PERMISSIONS) })).status).toBe(403);
    expect((await mod.patch(`/servers/${sid}/roles/${modRole.id}`, { name: 'Supremo' })).status).toBe(403);
  });

  it('moderador não concede ao @everyone permissão que não tem', async () => {
    const { mod, sid, detail } = await setup();
    const everyone = detail.roles.find((r) => r.isDefault)!;
    const res = await mod.patch(`/servers/${sid}/roles/${everyone.id}`, { permissions: p(DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_SERVER) });
    expect(res.status).toBe(403);
    // Remover algo que ele tem permissão de gerenciar é permitido.
    expect((await mod.patch(`/servers/${sid}/roles/${everyone.id}`, { permissions: p(DEFAULT_EVERYONE_PERMISSIONS & ~P.ATTACH_FILES) })).status).toBe(200);
  });

  it('moderador não move cargo para cima do seu', async () => {
    const { mod, sid } = await setup();
    const low = (await mod.post(`/servers/${sid}/roles`, { name: 'Baixo' })).body;
    expect((await mod.patch(`/servers/${sid}/roles/${low.id}`, { position: 5 })).status).toBe(403);
  });

  it('moderador não se atribui cargo superior nem expulsa o dono ou um par', async () => {
    const { owner, mod, member, sid, modRole } = await setup();
    const boss = (await owner.post(`/servers/${sid}/roles`, { name: 'Chefe', permissions: p(P.ADMINISTRATOR) })).body;
    await owner.patch(`/servers/${sid}/roles/${boss.id}`, { position: 2 });
    expect((await mod.put(`/servers/${sid}/members/${mod.id}/roles`, { roleIds: [modRole.id, boss.id] })).status).toBe(403);
    expect((await mod.del(`/servers/${sid}/members/${owner.id}`)).status).toBe(403);
    const mod2 = await user(app);
    await mod2.post(`/invites/${(await owner.post(`/servers/${sid}/invites`, {})).body.code}`);
    await owner.put(`/servers/${sid}/members/${mod2.id}/roles`, { roleIds: [modRole.id] });
    expect((await mod.del(`/servers/${sid}/members/${mod2.id}`)).status).toBe(403);
    // Membro comum (abaixo) pode ser expulso.
    expect((await mod.del(`/servers/${sid}/members/${member.id}`)).status).toBe(204);
    expect((await member.get(`/servers/${sid}`)).status).toBe(404);
  });

  it('IDs forjados de outro servidor não funcionam', async () => {
    const a = await setup();
    const b = await setup();
    // Dono do servidor A tenta usar um cargo do servidor B.
    expect((await a.owner.put(`/servers/${a.sid}/members/${a.member.id}/roles`, { roleIds: [b.modRole.id] })).status).toBe(404);
    expect((await a.owner.patch(`/servers/${b.sid}/roles/${b.modRole.id}`, { name: 'x' })).status).toBe(404);
    expect((await a.owner.patch(`/channels/${b.general.id}`, { name: 'x' })).status).toBe(404);
  });

  it('ajuste de canal não pode conceder permissão que o ator não tem', async () => {
    const { mod, general, detail } = await setup();
    const everyone = detail.roles.find((r) => r.isDefault)!;
    const res = await mod.put(`/channels/${general.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: p(P.MANAGE_SERVER), deny: '0' });
    expect(res.status).toBe(403);
  });
});

describe('canais e overwrites', () => {
  it('canal privado fica invisível para quem não tem acesso — inclusive em tempo real', async () => {
    const { owner, member, sid } = await setup();
    const secret = (await owner.post(`/servers/${sid}/channels`, { name: 'Staff Only', type: 'text', private: true })).body;
    expect(secret.name).toBe('staff-only');

    const visible = ((await member.get(`/servers/${sid}`)).body as ServerDetail).channels.map((c) => c.id);
    expect(visible).not.toContain(secret.id);
    expect((await member.get(`/channels/${secret.id}/messages`)).status).toBe(404);

    const l = listen(member.token);
    await l.ready;
    await owner.post(`/channels/${secret.id}/messages`, { content: 'plano secreto' });
    await sleep(150);
    expect(l.events.filter((e) => e.type === 'MESSAGE_CREATE')).toHaveLength(0);
    l.ws.close();
  });

  it('deny de envio para @everyone bloqueia; allow para um cargo libera', async () => {
    const { owner, mod, member, general, detail } = await setup();
    const everyone = detail.roles.find((r) => r.isDefault)!;
    await owner.put(`/channels/${general.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: p(P.SEND_MESSAGES) });
    expect((await member.post(`/channels/${general.id}/messages`, { content: 'oi' })).status).toBe(403);
    expect((await member.get(`/channels/${general.id}/messages`)).status).toBe(200);
    const modRoleId = ((await mod.get(`/servers/${detail.server.id}`)).body as ServerDetail).myRoleIds[0]!;
    await owner.put(`/channels/${general.id}/overwrites/${modRoleId}`, { targetType: 'role', allow: p(P.SEND_MESSAGES), deny: '0' });
    expect((await mod.post(`/channels/${general.id}/messages`, { content: 'liberado' })).status).toBe(201);
  });

  it('canal de voz não aceita mensagens de texto', async () => {
    const { owner, detail } = await setup();
    const voice = detail.channels.find((c) => c.type === 'voice')!;
    expect((await owner.post(`/channels/${voice.id}/messages`, { content: 'oi' })).status).toBe(400);
  });
});

describe('convites', () => {
  it('limite de usos, expiração e revogação', async () => {
    const owner = await user(app);
    const sid = ((await owner.post('/servers', { name: 'Fechado' })).body as ServerDetail).server.id;
    const once = (await owner.post(`/servers/${sid}/invites`, { maxUses: 1, maxAgeSeconds: 3600 })).body;
    expect(once.code).toMatch(/^[A-Za-z0-9]{10}$/);
    const a = await user(app);
    const b = await user(app);
    expect((await a.get(`/invites/${once.code}`)).body.server.name).toBe('Fechado');
    expect((await a.post(`/invites/${once.code}`)).status).toBe(200);
    expect((await b.post(`/invites/${once.code}`)).status).toBe(404);

    const revoked = (await owner.post(`/servers/${sid}/invites`, {})).body;
    await owner.del(`/invites/${revoked.code}`);
    expect((await b.post(`/invites/${revoked.code}`)).status).toBe(404);

    const expired = (await owner.post(`/servers/${sid}/invites`, {})).body;
    await app.db.query(`UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1`, [expired.code]);
    expect((await b.post(`/invites/${expired.code}`)).status).toBe(404);
    expect((await owner.post(`/servers/${sid}/invites`, { maxAgeSeconds: 12345 })).status).toBe(400);
  });

  it('dono não pode sair; membro sai e perde acesso', async () => {
    const { owner, member, sid } = await setup();
    expect((await owner.del(`/users/@me/servers/${sid}`)).status).toBe(400);
    expect((await member.del(`/users/@me/servers/${sid}`)).status).toBe(204);
    expect((await member.get(`/servers/${sid}`)).status).toBe(404);
  });
});

describe('mensagens', () => {
  it('nonce torna o reenvio idempotente', async () => {
    const { member, general } = await setup();
    const first = await member.post(`/channels/${general.id}/messages`, { content: 'só uma vez', nonce: 'n-123' });
    const retry = await member.post(`/channels/${general.id}/messages`, { content: 'só uma vez', nonce: 'n-123' });
    expect(retry.body.id).toBe(first.body.id);
    const list = (await member.get(`/channels/${general.id}/messages`)).body;
    expect(list.filter((m: { content: string }) => m.content === 'só uma vez')).toHaveLength(1);
  });

  it('edição só do autor; exclusão do autor ou de quem gerencia mensagens, com auditoria', async () => {
    const { owner, mod, member, general, sid } = await setup();
    const msg = (await member.post(`/channels/${general.id}/messages`, { content: 'original' })).body;
    expect((await mod.patch(`/channels/${general.id}/messages/${msg.id}`, { content: 'adulterado' })).status).toBe(403);
    const edited = await member.patch(`/channels/${general.id}/messages/${msg.id}`, { content: 'editado' });
    expect(edited.body).toMatchObject({ content: 'editado', editedAt: expect.any(String) });

    const other = (await mod.post(`/channels/${general.id}/messages`, { content: 'do mod' })).body;
    expect((await member.del(`/channels/${general.id}/messages/${other.id}`)).status).toBe(403);
    expect((await mod.del(`/channels/${general.id}/messages/${msg.id}`)).status).toBe(204);
    const log = (await owner.get(`/servers/${sid}/audit-log`)).body as Array<{ action: string }>;
    expect(log.map((l) => l.action)).toContain('message.delete');
  });

  it('pagina por cursor, responde citando e extrai menções', async () => {
    const { owner, member, general } = await setup();
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      sent.push((await owner.post(`/channels/${general.id}/messages`, { content: `m${i}` })).body.id);
      if (i === 3) await new Promise((r) => setTimeout(r, 1100)); // respeita o limite de 5 msgs/5 s
    }
    const page = (await member.get(`/channels/${general.id}/messages?limit=2&before=${sent[4]}`)).body;
    expect(page.map((m: { content: string }) => m.content)).toEqual(['m2', 'm3']);

    const reply = await member.post(`/channels/${general.id}/messages`, { content: `<@${owner.id}> concordo`, replyToId: sent[0] });
    expect(reply.body.replyTo).toMatchObject({ id: sent[0], content: 'm0' });
    expect(reply.body.mentions).toEqual([owner.id]);
  });

  it('reações: só emoji válido; contagem e "me" por usuário', async () => {
    const { owner, member, general } = await setup();
    const msg = (await owner.post(`/channels/${general.id}/messages`, { content: 'gg' })).body;
    const url = (e: string) => `/channels/${general.id}/messages/${msg.id}/reactions/${encodeURIComponent(e)}`;
    expect((await member.put(url('🔥'))).status).toBe(204);
    expect((await owner.put(url('🔥'))).status).toBe(204);
    expect((await member.put(url('<script>'))).status).toBe(400);
    let list = (await member.get(`/channels/${general.id}/messages`)).body;
    expect(list.at(-1).reactions).toEqual([{ emoji: '🔥', count: 2, me: true }]);
    await member.del(url('🔥'));
    list = (await member.get(`/channels/${general.id}/messages`)).body;
    expect(list.at(-1).reactions).toEqual([{ emoji: '🔥', count: 1, me: false }]);
  });

  it('busca trata % e _ como texto literal', async () => {
    const { owner, general } = await setup();
    await owner.post(`/channels/${general.id}/messages`, { content: 'desconto de 50% hoje' });
    await owner.post(`/channels/${general.id}/messages`, { content: 'nada a ver' });
    const res = (await owner.get(`/channels/${general.id}/messages/search?q=${encodeURIComponent('50%')}`)).body;
    expect(res.map((m: { content: string }) => m.content)).toEqual(['desconto de 50% hoje']);
    const none = (await owner.get(`/channels/${general.id}/messages/search?q=${encodeURIComponent('%')}`)).body;
    expect(none).toHaveLength(1);
  });

  it('limita mensagens em rajada', async () => {
    const { member, general } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await member.post(`/channels/${general.id}/messages`, { content: `spam ${i}` })).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('valida tamanho e conteúdo vazio', async () => {
    const { member, general } = await setup();
    expect((await member.post(`/channels/${general.id}/messages`, { content: '   ' })).status).toBe(400);
    expect((await member.post(`/channels/${general.id}/messages`, { content: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('marca leitura sem regredir', async () => {
    const { owner, member, general } = await setup();
    const a = (await owner.post(`/channels/${general.id}/messages`, { content: 'a' })).body.id;
    const b = (await owner.post(`/channels/${general.id}/messages`, { content: 'b' })).body.id;
    await member.post(`/channels/${general.id}/ack`, { messageId: b });
    await member.post(`/channels/${general.id}/ack`, { messageId: a });
    const rs = (await member.get('/users/@me/read-states')).body;
    expect(rs.find((r: { channelId: string }) => r.channelId === general.id).lastReadId).toBe(b);
  });

  it('denúncia de mensagem guarda cópia do conteúdo', async () => {
    const { owner, member, general } = await setup();
    const msg = (await owner.post(`/channels/${general.id}/messages`, { content: 'ofensa' })).body;
    expect((await member.post('/reports', { messageId: msg.id, reason: 'harassment' })).status).toBe(201);
    const { rows } = await app.db.query<{ snapshot: string; target_user_id: string }>('SELECT * FROM reports WHERE message_id = $1', [msg.id]);
    expect(rows[0]).toMatchObject({ snapshot: 'ofensa', target_user_id: owner.id });
  });
});

describe('tempo real', () => {
  it('entrega mensagens, digitação e sincronização apenas a quem pode ver', async () => {
    const { owner, member, general, sid } = await setup();
    const outsider: TestUser = await user(app);
    const lm = listen(member.token);
    const lo = listen(outsider.token);
    const lw = listen(owner.token);
    await Promise.all([lm.ready, lo.ready, lw.ready]);

    lw.send({ op: 'typing', channelId: general.id });
    await owner.post(`/channels/${general.id}/messages`, { content: 'ao vivo' });
    await owner.post(`/servers/${sid}/channels`, { name: 'novo', type: 'text' });
    await sleep(200);

    expect(lm.events.map((e) => e.type)).toEqual(expect.arrayContaining(['TYPING_START', 'MESSAGE_CREATE', 'SERVER_SYNC']));
    expect(lw.events.some((e) => e.type === 'TYPING_START')).toBe(false); // não ecoa para quem digita
    expect(lo.events.filter((e) => e.type !== 'PRESENCE_UPDATE')).toEqual([]);
    for (const l of [lm, lo, lw]) l.ws.close();
  });

  it('expulsão avisa o expulso com SERVER_REMOVE', async () => {
    const { owner, member, sid } = await setup();
    const lm = listen(member.token);
    await lm.ready;
    await owner.del(`/servers/${sid}/members/${member.id}`);
    await sleep(100);
    expect(lm.events).toContainEqual({ type: 'SERVER_REMOVE', serverId: sid });
    lm.ws.close();
  });
});
