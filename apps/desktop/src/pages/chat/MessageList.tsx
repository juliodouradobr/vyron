import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatTag, Permission as P } from '@nexo/protocol';
import { Hash } from 'lucide-react';
import { Avatar, Banner, Button, Spinner } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ReportDialog } from '../../components/ReportDialog';
import { formatDay, sameDay } from '../../lib/format';
import { describeError } from '../../services/api';
import { useMessages, type ClientMessage } from '../../stores/messages';
import { can } from '../../stores/servers';
import { useSession } from '../../stores/session';
import { GROUP_WINDOW_MS } from './constants';
import { MessageItem } from './MessageItem';
import type { ChatContext } from './useChatContext';

const EMPTY: ClientMessage[] = [];

export function MessageList({ ctx, onReply }: { ctx: ChatContext; onReply: (m: ClientMessage) => void }) {
  const { channelId } = ctx;
  const state = useMessages((s) => s.channels[channelId]);
  const items = state?.items ?? EMPTY;
  const selfId = useSession((s) => s.user?.id ?? '');
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restore = useRef<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ClientMessage | null>(null);
  const [toReport, setToReport] = useState<ClientMessage | null>(null);
  // Marca "novas mensagens" a partir do que estava lido quando o canal foi aberto.
  const [readMarker, setReadMarker] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setReadMarker(useMessages.getState().readStates[channelId] ?? null);
    setEditing(null);
    atBottom.current = true;
    const s = useMessages.getState().channels[channelId];
    if (!s?.loaded) void useMessages.getState().loadLatest(channelId);
  }, [channelId]);

  const ack = useCallback(() => {
    if (atBottom.current && document.hasFocus()) useMessages.getState().ack(channelId);
  }, [channelId]);

  useEffect(() => {
    window.addEventListener('focus', ack);
    return () => window.removeEventListener('focus', ack);
  }, [ack]);

  // Mantém a posição ao carregar histórico acima; cola no fim quando já estava no fim.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current != null) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    ack();
  }, [items, ack]);

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom.current) ack();
    if (el.scrollTop < 120 && state?.hasMore && !state.loading && state.loaded) {
      restore.current = el.scrollHeight - el.scrollTop;
      void useMessages.getState().loadOlder(channelId);
    }
  };

  const canManage = ctx.kind === 'server' && can(ctx.perms, P.MANAGE_MESSAGES);
  const canReact = can(ctx.perms, P.ADD_REACTIONS);
  let dividerShown = false;

  return (
    <div className="msg-list" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={`Mensagens de ${ctx.title}`}>
      {state?.loaded && !state.hasMore && <Welcome ctx={ctx} />}
      {state?.loading && <div className="msg-list__loading"><Spinner label="Carregando mensagens" /></div>}
      {state?.error && (
        <div className="msg-list__error">
          <Banner tone="error">{state.error}</Banner>
          <Button size="sm" variant="secondary" onClick={() => void useMessages.getState().loadLatest(channelId)}>
            Tentar de novo
          </Button>
        </div>
      )}
      {items.map((m, i) => {
        const prev = items[i - 1];
        const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
        const showNew = !dividerShown && readMarker !== undefined && !m.state && m.author.id !== selfId && (!readMarker || m.id > readMarker);
        if (showNew) dividerShown = true;
        const compact =
          !!prev && !newDay && !showNew && !m.replyTo && prev.author.id === m.author.id &&
          new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
        return (
          <Fragment key={m.nonce && m.state ? `n:${m.nonce}` : m.id}>
            {newDay && (
              <div className="divider divider--day" role="separator">
                <span>{formatDay(m.createdAt)}</span>
              </div>
            )}
            {showNew && (
              <div className="divider divider--new" role="separator">
                <span>Novas mensagens</span>
              </div>
            )}
            <MessageItem
              message={m}
              compact={compact}
              isMine={m.author.id === selfId}
              mentionsMe={m.mentions.includes(selfId)}
              canManage={canManage}
              canReact={canReact}
              users={ctx.users}
              colorOf={ctx.colorOf}
              editing={editing === m.id}
              onEdit={setEditing}
              onReply={onReply}
              onDelete={setToDelete}
              onReport={setToReport}
            />
          </Fragment>
        );
      })}
      {toDelete && (
        <ConfirmDialog
          title="Excluir mensagem?"
          confirmLabel="Excluir"
          danger
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            await useMessages
              .getState()
              .remove(channelId, toDelete.id)
              .catch((e) => {
                throw new Error(describeError(e));
              });
            setToDelete(null);
          }}
        >
          <blockquote className="quote">{toDelete.content.slice(0, 300)}</blockquote>
          {toDelete.author.id !== selfId && 'A exclusão de mensagens de outras pessoas fica registrada na auditoria.'}
        </ConfirmDialog>
      )}
      {toReport && <ReportDialog messageId={toReport.id} who={toReport.author.displayName} onClose={() => setToReport(null)} />}
    </div>
  );
}

function Welcome({ ctx }: { ctx: ChatContext }) {
  if (ctx.recipient) {
    return (
      <header className="welcome">
        <Avatar name={ctx.recipient.displayName} seed={ctx.recipient.id} imageId={ctx.recipient.avatarId} size={72} />
        <h2>{ctx.recipient.displayName}</h2>
        <p className="muted">Este é o começo da sua conversa privada com {formatTag(ctx.recipient)}.</p>
      </header>
    );
  }
  return (
    <header className="welcome">
      <span className="welcome__icon"><Hash size={36} aria-hidden /></span>
      <h2>Boas-vindas a #{ctx.title}!</h2>
      <p className="muted">{ctx.topic || 'Este é o começo do canal.'}</p>
    </header>
  );
}
