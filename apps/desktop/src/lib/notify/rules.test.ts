import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type UserSettings } from '@nexo/protocol';
import { decideFriendRequest, decideMessage, isMuted, muteUntil, notificationBody, pruneMutes, unreadMentions, type NotifyContext } from './rules';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const SRV = '00000000-0000-4000-8000-000000000001';
const CH = '00000000-0000-4000-8000-000000000002';
const ctx = (p: Partial<NotifyContext> = {}, s: Partial<UserSettings> = {}): NotifyContext => ({
  settings: { ...DEFAULT_SETTINGS, ...s },
  selfId: 'eu',
  status: 'online',
  focused: false,
  viewingChannelId: null,
  now: NOW,
  ...p,
});
const msg = (p: Partial<Parameters<typeof decideMessage>[0]> = {}) => ({ channelId: CH, serverId: SRV, authorId: 'outra', mentionsMe: false, ...p });

describe('decideMessage', () => {
  it('servidor: por padrão só menções', () => {
    expect(decideMessage(msg(), ctx()).popup).toBe(false);
    expect(decideMessage(msg({ mentionsMe: true }), ctx())).toMatchObject({ popup: true, sound: true, reason: 'menção' });
  });

  it('DM avisa; própria mensagem nunca', () => {
    expect(decideMessage(msg({ serverId: null }), ctx()).popup).toBe(true);
    expect(decideMessage(msg({ serverId: null, authorId: 'eu' }), ctx()).popup).toBe(false);
  });

  it('Não perturbe silencia tudo, inclusive o som', () => {
    expect(decideMessage(msg({ serverId: null }), ctx({ status: 'dnd' }))).toMatchObject({ popup: false, sound: false });
    expect(decideFriendRequest(ctx({ status: 'dnd' })).sound).toBe(false);
  });

  it('app em foco: sem aviso do sistema (só som); olhando o canal: nada', () => {
    expect(decideMessage(msg({ serverId: null }), ctx({ focused: true }))).toMatchObject({ popup: false, sound: true });
    expect(decideMessage(msg({ serverId: null }), ctx({ focused: true, viewingChannelId: CH }))).toMatchObject({ popup: false, sound: false });
    // Canal aberto, mas o app fora de foco: avisa (a pessoa não está olhando).
    expect(decideMessage(msg({ serverId: null }), ctx({ viewingChannelId: CH })).popup).toBe(true);
  });

  it('silenciar canal ou servidor, com prazo', () => {
    const later = new Date(NOW + 60_000).toISOString();
    const past = new Date(NOW - 60_000).toISOString();
    expect(decideMessage(msg({ mentionsMe: true }), ctx({}, { mutedChannels: { [CH]: later } })).reason).toBe('silenciado');
    expect(decideMessage(msg({ mentionsMe: true }), ctx({}, { mutedServers: { [SRV]: 'always' } })).reason).toBe('silenciado');
    expect(decideMessage(msg({ mentionsMe: true }), ctx({}, { mutedChannels: { [CH]: past } })).popup).toBe(true);
    expect(isMuted({ ...DEFAULT_SETTINGS, mutedServers: { [SRV]: later } }, SRV, 'x', NOW)).toBe(true);
  });

  it('nível por servidor sobrepõe o padrão; preferências desligam categorias', () => {
    expect(decideMessage(msg(), ctx({}, { serverNotify: { [SRV]: 'all' } })).popup).toBe(true);
    expect(decideMessage(msg({ mentionsMe: true }), ctx({}, { serverNotify: { [SRV]: 'none' } })).popup).toBe(false);
    expect(decideMessage(msg({ mentionsMe: true }), ctx({}, { notifyMentions: false })).popup).toBe(false);
    expect(decideMessage(msg({ serverId: null }), ctx({}, { notifyDms: false })).popup).toBe(false);
    expect(decideMessage(msg({ serverId: null }), ctx({}, { notifyDesktop: false }))).toMatchObject({ popup: false, sound: true });
    expect(decideMessage(msg({ serverId: null }), ctx({}, { notifySounds: false }))).toMatchObject({ popup: true, sound: false });
  });
});

describe('utilidades', () => {
  it('silenciar por prazo e limpar vencidos', () => {
    expect(muteUntil('always', NOW)).toBe('always');
    expect(muteUntil(3600_000, NOW)).toBe('2026-10-29T13:00:00.000Z');
    expect(pruneMutes({ a: 'always', b: new Date(NOW - 1).toISOString(), c: new Date(NOW + 1).toISOString() }, NOW)).toEqual({
      a: 'always',
      c: new Date(NOW + 1).toISOString(),
    });
  });

  it('corpo do aviso respeita "mostrar conteúdo" e resume anexos', () => {
    expect(notificationBody('segredo do clã', 0, false)).toBe('Nova mensagem');
    expect(notificationBody('  olha\n isso ', 2, true)).toBe('olha isso · 📎 2 anexos');
    expect(notificationBody('', 1, true)).toBe('📎 1 anexo');
    expect(notificationBody('x'.repeat(300), 0, true)).toHaveLength(138);
  });
});

describe('unreadMentions', () => {
  it('conta só as menções depois do ponto de leitura de cada canal', () => {
    const ids = { a: ['0190-1', '0190-3', '0190-5'], b: ['0190-2'], c: ['0190-4'] };
    expect(unreadMentions(ids, { a: '0190-3', b: '0190-9', c: null })).toEqual({ a: 1, c: 1 });
    expect(unreadMentions(ids, {})).toEqual({ a: 3, b: 1, c: 1 });
  });
});