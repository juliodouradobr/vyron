import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PublicUser } from '@nexo/protocol';
import { AlertCircle, CornerUpLeft, Flag, Pencil, RotateCw, SmilePlus, Trash2, X } from 'lucide-react';
import { Avatar } from '../../components/ui';
import { AttachmentList } from '../../components/Attachments';
import { colorHex } from '../../lib/permissions';
import { decodeMentions, encodeMentions, formatTime, formatTimestamp, parseContent } from '../../lib/format';
import { describeError } from '../../services/api';
import { useMessages, type ClientMessage } from '../../stores/messages';
import { openProfile } from '../../stores/ui';
import { QUICK_REACTIONS } from './constants';

interface Props {
  message: ClientMessage;
  compact: boolean;
  isMine: boolean;
  mentionsMe: boolean;
  canManage: boolean;
  canReact: boolean;
  users: PublicUser[];
  colorOf: (userId: string) => number | null;
  editing: boolean;
  onEdit: (id: string | null) => void;
  onReply: (m: ClientMessage) => void;
  onDelete: (m: ClientMessage) => void;
  onReport: (m: ClientMessage) => void;
}

export const MessageItem = memo(function MessageItem(props: Props) {
  const { message: m, compact, isMine, canManage, canReact, users, colorOf, editing } = props;
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const store = useMessages.getState;
  const color = colorHex(colorOf(m.author.id));
  const pending = m.state === 'pending';
  const failed = m.state === 'failed';

  const react = (emoji: string) => {
    setPicker(false);
    store()
      .toggleReaction(m.channelId, m.id, emoji)
      .catch((e) => setError(describeError(e)));
  };

  return (
    <article
      className={`msg ${compact ? 'msg--compact' : ''} ${pending ? 'msg--pending' : ''} ${failed ? 'msg--failed' : ''} ${
        props.mentionsMe ? 'msg--mention' : ''
      }`}
      aria-label={`${m.author.displayName}, ${formatTimestamp(m.createdAt)}`}
    >
      {m.replyTo && (
        <div className="msg__reply">
          <CornerUpLeft size={12} aria-hidden />
          {m.replyTo.author ? (
            <>
              <strong>@{m.replyTo.author.displayName}</strong>
              <span className="msg__reply-text">{m.replyTo.content}</span>
            </>
          ) : (
            <em className="muted">Mensagem original excluída</em>
          )}
        </div>
      )}
      <div className="msg__row">
        <div className="msg__gutter">
          {compact ? (
            <time className="msg__hover-time" dateTime={m.createdAt}>
              {formatTime(m.createdAt)}
            </time>
          ) : (
            <button className="msg__avatar" onClick={() => openProfile(m.author.id)} aria-label={`Perfil de ${m.author.displayName}`}>
              <Avatar name={m.author.displayName} seed={m.author.id} imageId={m.author.avatarId} size={40} />
            </button>
          )}
        </div>
        <div className="msg__body">
          {!compact && (
            <header className="msg__head">
              <button className="msg__author" style={color ? { color } : undefined} onClick={() => openProfile(m.author.id)}>
                {m.author.displayName}
              </button>
              <time className="msg__time" dateTime={m.createdAt}>
                {formatTimestamp(m.createdAt)}
              </time>
            </header>
          )}
          {editing ? (
            <EditBox message={m} users={users} onDone={() => props.onEdit(null)} />
          ) : (
            m.content && (
              <div className="msg__content">
                <Content text={m.content} users={users} />
                {m.editedAt && <span className="msg__edited" title={formatTimestamp(m.editedAt)}> (editada)</span>}
              </div>
            )
          )}
          <AttachmentList items={m.attachments ?? []} />
          {failed && (
            <div className="msg__failed" role="alert">
              <AlertCircle size={14} aria-hidden /> {m.error ?? 'Não enviada.'}
              <button className="link" onClick={() => void store().retry(m.channelId, m.nonce!)}>
                <RotateCw size={12} aria-hidden /> Tentar de novo
              </button>
              <button className="link link--muted" onClick={() => store().discard(m.channelId, m.nonce!)}>
                Descartar
              </button>
            </div>
          )}
          {error && <p className="msg__error">{error}</p>}
          {m.reactions.length > 0 && (
            <div className="reactions" role="group" aria-label="Reações">
              {m.reactions.map((r) => (
                <button
                  key={r.emoji}
                  className={`reaction ${r.me ? 'reaction--me' : ''}`}
                  aria-pressed={r.me}
                  aria-label={`${r.emoji} ${r.count} reação(ões)${r.me ? ', inclusive a sua' : ''}`}
                  onClick={() => react(r.emoji)}
                >
                  <span>{r.emoji}</span> {r.count}
                </button>
              ))}
            </div>
          )}
        </div>
        {!m.state && !editing && (
          <div className="msg__actions" role="toolbar" aria-label="Ações da mensagem">
            {canReact && (
              <button className="icon-btn" aria-label="Adicionar reação" onClick={() => setPicker((v) => !v)}>
                <SmilePlus size={16} />
              </button>
            )}
            <button className="icon-btn" aria-label="Responder" onClick={() => props.onReply(m)}>
              <CornerUpLeft size={16} />
            </button>
            {isMine && (
              <button className="icon-btn" aria-label="Editar" onClick={() => props.onEdit(m.id)}>
                <Pencil size={16} />
              </button>
            )}
            {(isMine || canManage) && (
              <button className="icon-btn icon-btn--danger" aria-label="Excluir" onClick={() => props.onDelete(m)}>
                <Trash2 size={16} />
              </button>
            )}
            {!isMine && (
              <button className="icon-btn" aria-label="Denunciar" onClick={() => props.onReport(m)}>
                <Flag size={16} />
              </button>
            )}
            {picker && (
              <div className="popover emoji-picker" role="menu" aria-label="Escolher reação">
                {QUICK_REACTIONS.map((e) => (
                  <button key={e} role="menuitem" className="emoji-picker__btn" onClick={() => react(e)} aria-label={`Reagir com ${e}`}>
                    {e}
                  </button>
                ))}
                <button className="icon-btn icon-btn--xs" aria-label="Fechar" onClick={() => setPicker(false)}>
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
});

function Content({ text, users }: { text: string; users: PublicUser[] }) {
  return (
    <>
      {parseContent(text).map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
        if (seg.kind === 'link') {
          return (
            // Links abrem fora do app, sem referer e sem acesso à janela de origem.
            <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer nofollow" className="msg__link">
              {seg.text}
            </a>
          );
        }
        const u = users.find((x) => x.id === seg.userId);
        return (
          <button key={i} className="mention" onClick={() => openProfile(seg.userId)}>
            @{u?.displayName ?? 'usuário desconhecido'}
          </button>
        );
      })}
    </>
  );
}

function EditBox({ message, users, onDone }: { message: ClientMessage; users: PublicUser[]; onDone: () => void }) {
  const [value, setValue] = useState(() => decodeMentions(message.content, users));
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  const save = async () => {
    const content = encodeMentions(value, users);
    if (!content.trim() || content === message.content) return onDone();
    try {
      await useMessages.getState().edit(message.channelId, message.id, content);
      onDone();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDone();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="edit-box">
      <textarea ref={ref} className="edit-box__input" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} rows={2} maxLength={2000} aria-label="Editar mensagem" />
      <p className="edit-box__hint">
        Esc para <button className="link" onClick={onDone}>cancelar</button> · Enter para <button className="link" onClick={() => void save()}>salvar</button>
      </p>
      {error && <p className="msg__error">{error}</p>}
    </div>
  );
}
