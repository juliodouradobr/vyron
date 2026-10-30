import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@nexo/protocol';
import { ApiError } from '../services/api';
import { isUnread, useMessages } from './messages';
import { api, useSession } from './session';

const CH = 'chan-1';
const me = { id: 'u-me', username: 'eu', discriminator: '00001', displayName: 'Eu', bio: '', avatarId: null, bannerId: null, createdAt: '2026-01-01T00:00:00Z', status: 'online' as const };
const other = { id: 'u-2', username: 'outro', discriminator: '00002', displayName: 'Outro', bio: '', avatarId: null, bannerId: null, createdAt: '2026-01-01T00:00:00Z' };

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: CH,
  author: other,
  content: `m ${id}`,
  attachments: [],
  replyTo: null,
  mentions: [],
  reactions: [],
  createdAt: '2026-10-25T12:00:00Z',
  editedAt: null,
  nonce: null,
  ...over,
});

beforeEach(() => {
  useSession.setState({ user: me });
  useMessages.getState().reset();
  useMessages.setState({ channels: { [CH]: { items: [], loaded: true, loading: false, hasMore: false, error: null } } });
});
afterEach(() => vi.restoreAllMocks());

describe('envio otimista', () => {
  it('mostra a mensagem como pendente e troca pela confirmada sem duplicar, mesmo se o evento chegar antes', async () => {
    let resolve!: (m: Message) => void;
    vi.spyOn(api, 'sendMessage').mockImplementation((_c, input) => new Promise((r) => (resolve = () => r(msg('0192-b', { author: me, content: input.content, nonce: input.nonce })))));
    const sending = useMessages.getState().send(CH, 'olá');
    const pending = useMessages.getState().channels[CH]!.items[0]!;
    expect(pending).toMatchObject({ state: 'pending', content: 'olá' });

    // O gateway entrega a mensagem antes da resposta HTTP.
    useMessages.getState().applyCreate(msg('0192-b', { author: me, content: 'olá', nonce: pending.nonce }));
    resolve(msg('0192-b'));
    await sending;
    const items = useMessages.getState().channels[CH]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('0192-b');
    expect(items[0]!.state).toBeUndefined();
  });

  it('marca falha e reenvia com o MESMO nonce', async () => {
    const send = vi.spyOn(api, 'sendMessage').mockRejectedValueOnce(new ApiError('NETWORK', 'Sem conexão.'));
    await useMessages.getState().send(CH, 'tentativa');
    const failed = useMessages.getState().channels[CH]!.items[0]!;
    expect(failed).toMatchObject({ state: 'failed', error: 'Sem conexão.' });

    send.mockResolvedValueOnce(msg('0192-c', { author: me, content: 'tentativa', nonce: failed.nonce }));
    await useMessages.getState().retry(CH, failed.nonce!);
    expect(send.mock.calls[1]![1].nonce).toBe(send.mock.calls[0]![1].nonce);
    expect(useMessages.getState().channels[CH]!.items).toEqual([expect.objectContaining({ id: '0192-c' })]);
  });
});

describe('eventos', () => {
  it('ordena por id, ignora duplicatas e preserva reações ao editar', () => {
    const s = useMessages.getState();
    s.applyCreate(msg('0192-2'));
    s.applyCreate(msg('0192-1'));
    s.applyCreate(msg('0192-2'));
    s.applyReactions(CH, '0192-1', [{ emoji: '🔥', count: 1, userIds: [me.id] }]);
    s.applyUpdate(msg('0192-1', { content: 'editada', editedAt: '2026-10-25T12:01:00Z' }));
    const items = useMessages.getState().channels[CH]!.items;
    expect(items.map((m) => m.id)).toEqual(['0192-1', '0192-2']);
    expect(items[0]).toMatchObject({ content: 'editada', reactions: [{ emoji: '🔥', count: 1, me: true }] });
  });

  it('exclusão marca respostas à mensagem como "original excluída"', () => {
    const s = useMessages.getState();
    s.applyCreate(msg('0192-1'));
    s.applyCreate(msg('0192-2', { replyTo: { id: '0192-1', author: other, content: 'x' } }));
    s.applyDelete(CH, '0192-1');
    expect(useMessages.getState().channels[CH]!.items[0]!.replyTo).toEqual({ id: '0192-1', author: null, content: '' });
  });
});

describe('não lidas', () => {
  it('compara ids ordenáveis por tempo', () => {
    expect(isUnread('0192-b', '0192-a')).toBe(true);
    expect(isUnread('0192-a', '0192-a')).toBe(false);
    expect(isUnread('0192-a', null)).toBe(true);
    expect(isUnread(null, null)).toBe(false);
  });

  it('mensagem própria não deixa o canal como não lido', () => {
    useMessages.getState().applyCreate(msg('0192-9', { author: me }));
    const s = useMessages.getState();
    expect(isUnread(s.lastMessageId[CH], s.readStates[CH])).toBe(false);
  });
});
