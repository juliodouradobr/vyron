import { create } from 'zustand';
import { publicOfSelf, type Attachment, type Message, type PublicUser } from '@nexo/protocol';
import { ApiError, describeError } from '../services/api';
import { api, useSession } from './session';

/** Mensagem como o cliente a vê: pode estar enviando ou ter falhado (com o motivo). */
export interface ClientMessage extends Message {
  state?: 'pending' | 'failed';
  error?: string;
}

interface ChannelMessages {
  items: ClientMessage[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
}

const PAGE = 50;
/** Teto de mensagens mantidas em memória por canal: históricos longos não crescem sem limite. */
const MAX_IN_MEMORY = 500;
const TYPING_MS = 8000;

interface MessagesState {
  channels: Record<string, ChannelMessages>;
  lastMessageId: Record<string, string | null>;
  readStates: Record<string, string | null>;
  typing: Record<string, Record<string, number>>;

  seedLastMessages(entries: Array<[string, string | null]>): void;
  loadReadStates(): Promise<void>;
  loadLatest(channelId: string): Promise<void>;
  loadOlder(channelId: string): Promise<void>;
  /** Anexos já enviados (pendentes no servidor); a mensagem os vincula. */
  send(channelId: string, content: string, replyToId?: string, attachments?: Attachment[]): Promise<void>;
  retry(channelId: string, nonce: string): Promise<void>;
  discard(channelId: string, nonce: string): void;
  retryAllFailed(): void;
  edit(channelId: string, messageId: string, content: string): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  toggleReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  ack(channelId: string): void;

  applyCreate(m: Message): void;
  applyUpdate(m: Message): void;
  applyDelete(channelId: string, messageId: string): void;
  applyReactions(channelId: string, messageId: string, reactions: Array<{ emoji: string; count: number; userIds: string[] }>): void;
  applyTyping(channelId: string, userId: string): void;
  reset(): void;
}

const empty = (): ChannelMessages => ({ items: [], loaded: false, loading: false, hasMore: true, error: null });

/** UUIDv7 em texto ordena igual ao tempo: comparar strings basta. */
export const isUnread = (last: string | null | undefined, read: string | null | undefined) => !!last && (!read || last > read);

function selfAuthor(): PublicUser {
  return publicOfSelf(useSession.getState().user!);
}

const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useMessages = create<MessagesState>((set, get) => {
  const patch = (channelId: string, fn: (c: ChannelMessages) => Partial<ChannelMessages>) => {
    const cur = get().channels[channelId] ?? empty();
    set({ channels: { ...get().channels, [channelId]: { ...cur, ...fn(cur) } } });
  };

  /** Insere ou substitui por id/nonce, mantendo ordem cronológica e sem duplicar. */
  const upsert = (items: ClientMessage[], m: ClientMessage): ClientMessage[] => {
    const idx = items.findIndex((x) => x.id === m.id || (m.nonce && x.nonce === m.nonce && x.author.id === m.author.id));
    const next = idx >= 0 ? items.map((x, i) => (i === idx ? { ...m, reactions: m.reactions.length ? m.reactions : x.reactions } : x)) : [...items, m];
    const sent = next.filter((x) => !x.state).sort((a, b) => (a.id < b.id ? -1 : 1));
    // Pendentes/falhas ficam no fim, na ordem em que foram digitadas.
    return [...sent, ...next.filter((x) => x.state)].slice(-MAX_IN_MEMORY);
  };

  async function deliver(channelId: string, nonce: string, content: string, replyToId?: string, attachments: Attachment[] = []) {
    try {
      const attachmentIds = attachments.map((a) => a.id);
      const m = await api.sendMessage(channelId, { content, nonce, replyToId, ...(attachmentIds.length ? { attachmentIds } : {}) });
      patch(channelId, (c) => ({ items: upsert(c.items, m) }));
      set({ lastMessageId: { ...get().lastMessageId, [channelId]: m.id }, readStates: { ...get().readStates, [channelId]: m.id } });
    } catch (err) {
      patch(channelId, (c) => ({
        items: c.items.map((x) => (x.nonce === nonce && x.state ? { ...x, state: 'failed', error: describeError(err) } : x)),
      }));
    }
  }

  return {
    channels: {},
    lastMessageId: {},
    readStates: {},
    typing: {},

    seedLastMessages(entries) {
      const next = { ...get().lastMessageId };
      for (const [id, last] of entries) if (!next[id] || (last && last > next[id]!)) next[id] = last;
      set({ lastMessageId: next });
    },

    async loadReadStates() {
      const rs = await api.readStates();
      set({ readStates: Object.fromEntries(rs.map((r) => [r.channelId, r.lastReadId])) });
    },

    async loadLatest(channelId) {
      patch(channelId, () => ({ loading: true, error: null }));
      try {
        const page = await api.messages(channelId, { limit: PAGE });
        patch(channelId, (c) => ({
          // Mantém pendentes locais; o resto vem do servidor (fonte de verdade).
          items: page.reduce(upsert, c.items.filter((x) => x.state)),
          loaded: true,
          loading: false,
          hasMore: page.length === PAGE,
        }));
      } catch (err) {
        patch(channelId, () => ({ loading: false, error: describeError(err) }));
      }
    },

    async loadOlder(channelId) {
      const c = get().channels[channelId];
      if (!c || c.loading || !c.hasMore) return;
      const oldest = c.items.find((x) => !x.state);
      patch(channelId, () => ({ loading: true }));
      try {
        const page = await api.messages(channelId, { before: oldest?.id, limit: PAGE });
        patch(channelId, (cur) => ({ items: [...page, ...cur.items], loading: false, hasMore: page.length === PAGE }));
      } catch (err) {
        patch(channelId, () => ({ loading: false, error: describeError(err) }));
      }
    },

    async send(channelId, content, replyToId, attachments = []) {
      const nonce = crypto.randomUUID();
      const author = selfAuthor();
      const reply = replyToId ? get().channels[channelId]?.items.find((x) => x.id === replyToId) : undefined;
      const optimistic: ClientMessage = {
        id: `pending:${nonce}`,
        channelId,
        author,
        content,
        attachments,
        replyTo: reply ? { id: reply.id, author: reply.author, content: reply.content } : null,
        mentions: [],
        reactions: [],
        createdAt: new Date().toISOString(),
        editedAt: null,
        nonce,
        state: 'pending',
      };
      patch(channelId, (c) => ({ items: [...c.items, optimistic] }));
      await deliver(channelId, nonce, content, replyToId, attachments);
    },

    /** Reenvia com o MESMO nonce: se a primeira tentativa chegou ao servidor, não duplica. */
    async retry(channelId, nonce) {
      const m = get().channels[channelId]?.items.find((x) => x.nonce === nonce && x.state === 'failed');
      if (!m) return;
      patch(channelId, (c) => ({ items: c.items.map((x) => (x === m ? { ...x, state: 'pending', error: undefined } : x)) }));
      await deliver(channelId, nonce, m.content, m.replyTo?.id, m.attachments);
    },

    discard(channelId, nonce) {
      patch(channelId, (c) => ({ items: c.items.filter((x) => !(x.nonce === nonce && x.state)) }));
    },

    /** Ao reconectar, tenta de novo o que falhou por falta de rede. */
    retryAllFailed() {
      for (const [channelId, c] of Object.entries(get().channels)) {
        for (const m of c.items) if (m.state === 'failed' && m.nonce) void get().retry(channelId, m.nonce);
      }
    },

    async edit(channelId, messageId, content) {
      const m = await api.editMessage(channelId, messageId, content);
      get().applyUpdate(m);
    },

    async remove(channelId, messageId) {
      await api.deleteMessage(channelId, messageId);
      get().applyDelete(channelId, messageId);
    },

    async toggleReaction(channelId, messageId, emoji) {
      const m = get().channels[channelId]?.items.find((x) => x.id === messageId);
      const mine = m?.reactions.find((r) => r.emoji === emoji)?.me;
      if (mine) await api.removeReaction(channelId, messageId, emoji);
      else await api.addReaction(channelId, messageId, emoji);
    },

    /** Marca o canal como lido até a última mensagem (com debounce para não enviar a cada evento). */
    ack(channelId) {
      const last = get().lastMessageId[channelId];
      if (!last || !isUnread(last, get().readStates[channelId])) return;
      set({ readStates: { ...get().readStates, [channelId]: last } });
      clearTimeout(ackTimers.get(channelId));
      ackTimers.set(
        channelId,
        setTimeout(() => {
          ackTimers.delete(channelId);
          api.ack(channelId, last).catch((err) => {
            if (!(err instanceof ApiError)) console.warn('falha ao marcar como lido', err);
          });
        }, 500),
      );
    },

    applyCreate(m) {
      const c = get().channels[m.channelId];
      if (c?.loaded) patch(m.channelId, (cur) => ({ items: upsert(cur.items, m) }));
      const typing = { ...get().typing[m.channelId] };
      delete typing[m.author.id];
      const mine = m.author.id === useSession.getState().user?.id;
      set({
        lastMessageId: { ...get().lastMessageId, [m.channelId]: m.id },
        typing: { ...get().typing, [m.channelId]: typing },
        ...(mine ? { readStates: { ...get().readStates, [m.channelId]: m.id } } : {}),
      });
    },

    applyUpdate(m) {
      patch(m.channelId, (c) => ({
        items: c.items.map((x) => (x.id === m.id ? { ...x, content: m.content, editedAt: m.editedAt, mentions: m.mentions } : x)),
      }));
    },

    applyDelete(channelId, messageId) {
      patch(channelId, (c) => ({
        items: c.items
          .filter((x) => x.id !== messageId)
          .map((x) => (x.replyTo?.id === messageId ? { ...x, replyTo: { id: messageId, author: null, content: '' } } : x)),
      }));
    },

    applyReactions(channelId, messageId, reactions) {
      const me = useSession.getState().user?.id ?? '';
      patch(channelId, (c) => ({
        items: c.items.map((x) =>
          x.id === messageId ? { ...x, reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count, me: r.userIds.includes(me) })) } : x,
        ),
      }));
    },

    applyTyping(channelId, userId) {
      set({ typing: { ...get().typing, [channelId]: { ...get().typing[channelId], [userId]: Date.now() + TYPING_MS } } });
    },

    reset: () => set({ channels: {}, lastMessageId: {}, readStates: {}, typing: {} }),
  };
});
