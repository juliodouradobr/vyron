import { useEffect, useState } from 'react';
import type { Message } from '@nexo/protocol';
import { AtSign, UserPlus } from 'lucide-react';
import { Avatar, Banner, Button, Modal, Spinner } from './ui';
import { describeError } from '../services/api';
import { formatTimestamp, parseContent } from '../lib/format';
import { loadMentions, nameOf, unreadMentions, useNotify } from '../lib/notify/engine';
import { isUnread, useMessages } from '../stores/messages';
import { useNav } from '../stores/nav';
import { useServers } from '../stores/servers';
import { api } from '../stores/session';
import { useSocial } from '../stores/social';

/** Total de menções não lidas (para o sino). */
export function useUnreadMentionTotal(): number {
  const ids = useNotify((s) => s.mentionIds);
  const read = useMessages((s) => s.readStates);
  return Object.values(unreadMentions(ids, read)).reduce((a, b) => a + b, 0);
}

function whereOf(channelId: string) {
  for (const d of Object.values(useServers.getState().details)) {
    const ch = d.channels.find((c) => c.id === channelId);
    if (ch) return { label: `#${ch.name} · ${d.server.name}`, serverId: d.server.id };
  }
  return { label: 'Mensagem direta', serverId: null };
}

/**
 * Caixa de entrada: menções recentes (só de canais que você ainda pode ver — o servidor confere) e
 * pedidos de amizade pendentes.
 */
export function InboxModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useMessages((s) => s.readStates);
  const pending = useSocial((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);

  useEffect(() => {
    loadMentions().then(
      (l) => {
        setItems(l);
        setMore(l.length >= 25);
      },
      (e) => setError(describeError(e)),
    );
  }, []);

  const loadMore = async () => {
    if (!items?.length) return;
    setBusy(true);
    try {
      const next = await api.mentions(items[items.length - 1]!.id);
      useNotify.getState().seedMentions(next);
      setItems([...items, ...next]);
      setMore(next.length >= 25);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (m: Message) => {
    const w = whereOf(m.channelId);
    useNav.getState().go(w.serverId ? { kind: 'server', serverId: w.serverId, channelId: m.channelId } : { kind: 'dm', channelId: m.channelId });
    onClose();
  };

  const markAllRead = () => {
    const msgs = useMessages.getState();
    for (const ch of new Set((items ?? []).map((m) => m.channelId))) msgs.ack(ch);
  };

  const text = (m: Message) =>
    parseContent(m.content)
      .map((s) => (s.kind === 'mention' ? `@${nameOf(s.userId)}` : s.text))
      .join('')
      .slice(0, 200);

  return (
    <Modal
      title="Caixa de entrada"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={markAllRead} disabled={!items?.some((m) => isUnread(m.id, read[m.channelId]))}>
            Marcar tudo como lido
          </Button>
          <Button onClick={onClose}>Fechar</Button>
        </>
      }
    >
      <div className="stack">
        {pending > 0 && (
          <button
            className="inbox-row inbox-row--request"
            onClick={() => {
              useNav.getState().setFriendsTab('pending');
              useNav.getState().go({ kind: 'friends' });
              onClose();
            }}
          >
            <UserPlus size={18} aria-hidden />
            <span>
              {pending === 1 ? '1 pedido de amizade pendente' : `${pending} pedidos de amizade pendentes`}
            </span>
          </button>
        )}
        <h3 className="field__label">
          <AtSign size={12} aria-hidden /> Menções
        </h3>
        {error && <Banner tone="error">{error}</Banner>}
        {!items && !error && <Spinner />}
        {items && items.length === 0 && <p className="muted">Ninguém mencionou você recentemente.</p>}
        {items && items.length > 0 && (
          <ul className="inbox-list">
            {items.map((m) => {
              const unread = isUnread(m.id, read[m.channelId]);
              return (
                <li key={m.id}>
                  <button className={`inbox-row ${unread ? 'inbox-row--unread' : ''}`} onClick={() => open(m)}>
                    <Avatar name={m.author.displayName} seed={m.author.id} imageId={m.author.avatarId} size={32} />
                    <span className="inbox-row__body">
                      <span className="inbox-row__head">
                        <strong>{m.author.displayName}</strong>
                        <span className="muted"> · {whereOf(m.channelId).label}</span>
                        <time className="muted"> · {formatTimestamp(m.createdAt)}</time>
                      </span>
                      <span className="inbox-row__text">
                        {text(m) || (m.attachments.length ? `📎 ${m.attachments.length} anexo(s)` : '')}
                      </span>
                    </span>
                    {unread && <span className="unread-dot" aria-label="não lida" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {more && items && items.length > 0 && (
          <Button variant="secondary" onClick={() => void loadMore()} loading={busy}>
            Carregar mais antigas
          </Button>
        )}
      </div>
    </Modal>
  );
}
