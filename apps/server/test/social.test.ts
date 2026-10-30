import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { befriend, createTestApp, uniqueName, user } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const rels = async (u: Awaited<ReturnType<typeof user>>) =>
  ((await u.get('/users/@me/relationships')).body as Array<{ user: { id: string }; type: string }>).map((r) => [r.user.id, r.type]);

describe('amizades', () => {
  it('pedido → pendente dos dois lados → aceito vira amizade', async () => {
    const a = await user(app);
    const b = await user(app);
    const sent = await a.post('/users/@me/relationships', { username: b.username.toUpperCase() });
    expect(sent.status).toBe(201);
    expect(await rels(a)).toEqual([[b.id, 'outgoing']]);
    expect(await rels(b)).toEqual([[a.id, 'incoming']]);

    // Quem enviou não pode "aceitar" o próprio pedido.
    expect((await a.put(`/users/@me/relationships/${b.id}`)).status).toBe(404);
    expect((await b.put(`/users/@me/relationships/${a.id}`)).status).toBe(200);
    expect(await rels(a)).toEqual([[b.id, 'friend']]);
    expect(await rels(b)).toEqual([[a.id, 'friend']]);
  });

  it('pedidos cruzados viram amizade automaticamente', async () => {
    const a = await user(app);
    const b = await user(app);
    await a.post('/users/@me/relationships', { username: b.username });
    const res = await b.post('/users/@me/relationships', { username: a.username });
    expect(res.body.type).toBe('friend');
  });

  it('recusar, cancelar e remover limpam os dois lados', async () => {
    const a = await user(app);
    const b = await user(app);
    await a.post('/users/@me/relationships', { username: b.username });
    expect((await b.del(`/users/@me/relationships/${a.id}`)).status).toBe(204);
    expect(await rels(a)).toEqual([]);
    await befriend(a, b);
    await a.del(`/users/@me/relationships/${b.id}`);
    expect(await rels(b)).toEqual([]);
  });

  it('valida a si mesmo e usuário inexistente', async () => {
    const a = await user(app);
    expect((await a.post('/users/@me/relationships', { username: a.username })).status).toBe(400);
    expect((await a.post('/users/@me/relationships', { username: 'nao_existe_mesmo' })).body.error.code).toBe('UNKNOWN_ACCOUNT');
    // Nome certo com o número errado não encontra ninguém.
    const wrong = a.discriminator === '00001' ? '00002' : '00001';
    expect((await a.post('/users/@me/relationships', { username: `${a.username}#${wrong}` })).body.error.code).toBe('UNKNOWN_ACCOUNT');
  });

  it('com nome repetido, o identificador completo decide a pessoa', async () => {
    const name = uniqueName();
    const a = await user(app);
    const b1 = await user(app, name);
    const b2 = await user(app, name);
    expect((await a.post('/users/@me/relationships', { username: name })).body.error.code).toBe('AMBIGUOUS_USERNAME');
    const sent = await a.post('/users/@me/relationships', { username: b2.tag });
    expect(sent.status).toBe(201);
    expect(sent.body.user).toMatchObject({ id: b2.id, discriminator: b2.user.discriminator });
    expect(await rels(b1)).toEqual([]);
  });

  it('respeita a privacidade "ninguém pode me adicionar"', async () => {
    const a = await user(app);
    const b = await user(app);
    await b.put('/users/@me/settings', { friendRequestsFrom: 'nobody' });
    expect((await a.post('/users/@me/relationships', { username: b.username })).status).toBe(403);
  });
});

describe('bloqueio', () => {
  it('desfaz a amizade, impede novo pedido sem revelar o bloqueio e impede DMs', async () => {
    const a = await user(app);
    const b = await user(app);
    await befriend(a, b);
    const dm = (await a.post('/users/@me/channels', { recipientId: b.id })).body;
    expect((await a.post(`/channels/${dm.id}/messages`, { content: 'oi' })).status).toBe(201);

    expect((await b.put(`/users/@me/relationships/${a.id}/block`)).status).toBe(200);
    expect(await rels(a)).toEqual([]);
    expect(await rels(b)).toEqual([[a.id, 'blocked']]);

    const req = await a.post('/users/@me/relationships', { username: b.username });
    expect(req.status).toBe(403);
    expect(req.body.error.message).not.toMatch(/bloque/i);
    expect((await a.post(`/channels/${dm.id}/messages`, { content: 'ainda aí?' })).status).toBe(403);
    expect((await b.post(`/channels/${dm.id}/messages`, { content: 'não' })).status).toBe(403);
  });

  it('desbloquear não recria a amizade', async () => {
    const a = await user(app);
    const b = await user(app);
    await befriend(a, b);
    await a.put(`/users/@me/relationships/${b.id}/block`);
    await a.del(`/users/@me/relationships/${b.id}`);
    expect(await rels(a)).toEqual([]);
    expect(await rels(b)).toEqual([]);
  });
});

describe('mensagens diretas', () => {
  it('estranhos sem servidor em comum não podem iniciar conversa', async () => {
    const a = await user(app);
    const b = await user(app);
    expect((await a.post('/users/@me/channels', { recipientId: b.id })).status).toBe(403);
  });

  it('amigos conversam; abrir de novo devolve a mesma conversa; terceiros não leem', async () => {
    const a = await user(app);
    const b = await user(app);
    const c = await user(app);
    await befriend(a, b);
    const first = (await a.post('/users/@me/channels', { recipientId: b.id })).body;
    const again = (await b.post('/users/@me/channels', { recipientId: a.id })).body;
    expect(again.id).toBe(first.id);
    await a.post(`/channels/${first.id}/messages`, { content: 'segredo' });
    expect((await c.get(`/channels/${first.id}/messages`)).status).toBe(404);
    expect((await c.post(`/channels/${first.id}/messages`, { content: 'intruso' })).status).toBe(404);
    const list = (await b.get('/users/@me/channels')).body;
    expect(list[0]).toMatchObject({ id: first.id, recipient: { id: a.id } });
  });

  it('membros de um servidor em comum podem conversar, salvo se o destinatário desativar', async () => {
    const owner = await user(app);
    const b = await user(app);
    const server = (await owner.post('/servers', { name: 'Comum' })).body;
    const inv = (await owner.post(`/servers/${server.server.id}/invites`, {})).body;
    await b.post(`/invites/${inv.code}`);
    expect((await b.post('/users/@me/channels', { recipientId: owner.id })).status).toBe(200);
    const c = await user(app);
    await c.post(`/invites/${inv.code}`);
    await owner.put('/users/@me/settings', { allowDmsFromServerMembers: false });
    expect((await c.post('/users/@me/channels', { recipientId: owner.id })).status).toBe(403);
  });

  it('ninguém apaga mensagem alheia em DM', async () => {
    const a = await user(app);
    const b = await user(app);
    await befriend(a, b);
    const dm = (await a.post('/users/@me/channels', { recipientId: b.id })).body;
    const msg = (await a.post(`/channels/${dm.id}/messages`, { content: 'minha' })).body;
    expect((await b.del(`/channels/${dm.id}/messages/${msg.id}`)).status).toBe(403);
  });
});

describe('perfil público', () => {
  it('não expõe dados privados', async () => {
    const a = await user(app);
    const b = await user(app);
    const res = await a.get(`/users/${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: b.id,
      username: b.username,
      discriminator: b.discriminator,
      displayName: b.username, bio: '', avatarId: null, bannerId: null, createdAt: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|status|session/i);
  });
});
