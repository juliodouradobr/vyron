import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Permission as P, type Message, type ServerDetail } from '@nexo/protocol';
import { befriend, createTestApp, user } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('caixa de menções', () => {
  it('lista menções de canais visíveis e de DMs, mais recentes primeiro; some ao perder acesso ao canal', async () => {
    const owner = await user(app);
    const member = await user(app);
    const d = (await owner.post('/servers', { name: 'Menções' })).body as ServerDetail;
    await member.post(`/invites/${(await owner.post(`/servers/${d.server.id}/invites`, {})).body.code}`);
    const text = d.channels.find((c) => c.type === 'text')!;
    const everyone = d.roles.find((r) => r.isDefault)!;

    await owner.post(`/channels/${text.id}/messages`, { content: 'sem menção' });
    const m1 = (await owner.post(`/channels/${text.id}/messages`, { content: `oi <@${member.id}>` })).body as Message;
    // Mencionar a si mesmo não entra na própria caixa.
    await member.post(`/channels/${text.id}/messages`, { content: `eu mesmo <@${member.id}>` });

    await befriend(owner, member);
    const dm = (await owner.post('/users/@me/channels', { recipientId: member.id })).body;
    const m2 = (await owner.post(`/channels/${dm.id}/messages`, { content: `<@${member.id}> viu?` })).body as Message;

    let box = (await member.get('/users/@me/mentions')).body as Message[];
    expect(box.map((m) => m.id)).toEqual([m2.id, m1.id]);
    expect(box[0]!.author.id).toBe(owner.id);

    // Paginação
    box = (await member.get(`/users/@me/mentions?before=${m2.id}`)).body as Message[];
    expect(box.map((m) => m.id)).toEqual([m1.id]);

    // Perder VIEW_CHANNEL no canal: as menções dele somem.
    await owner.put(`/channels/${text.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.VIEW_CHANNEL.toString() });
    box = (await member.get('/users/@me/mentions')).body as Message[];
    expect(box.map((m) => m.id)).toEqual([m2.id]);

    // Quem não está no servidor nunca vê menções de lá, nem as de outras pessoas.
    const outsider = await user(app);
    expect((await outsider.get('/users/@me/mentions')).body).toEqual([]);
  });
});

describe('preferências de notificação', () => {
  it('padrões seguros e validação dos mapas de silenciar', async () => {
    const u = await user(app);
    const s = (await u.get('/users/@me/settings')).body.settings;
    expect(s).toMatchObject({ notifyDesktop: true, notifyDms: true, notifyMentions: true, notifyServerDefault: 'mentions', mutedChannels: {} });

    const sid = '00000000-0000-4000-8000-000000000001';
    const ok = await u.put('/users/@me/settings', { ...DEFAULT_SETTINGS, mutedServers: { [sid]: 'always' }, serverNotify: { [sid]: 'all' } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.mutedServers[sid]).toBe('always');

    expect((await u.put('/users/@me/settings', { ...DEFAULT_SETTINGS, mutedChannels: { [sid]: 'amanhã' } })).status).toBe(400);
    const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'always']));
    expect((await u.put('/users/@me/settings', { ...DEFAULT_SETTINGS, mutedChannels: tooMany })).status).toBe(400);
  });
});
