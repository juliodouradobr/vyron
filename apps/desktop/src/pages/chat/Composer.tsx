import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { formatTag, MESSAGE_MAX_LENGTH, Permission as P, type PublicUser } from '@nexo/protocol';
import { FileText, Lock, Paperclip, SendHorizontal, X } from 'lucide-react';
import { Avatar } from '../../components/ui';
import { encodeMentions } from '../../lib/format';
import { sendTyping } from '../../services/realtime';
import { useMessages, type ClientMessage } from '../../stores/messages';
import { can } from '../../stores/servers';
import { useSession } from '../../stores/session';
import type { ChatContext } from './useChatContext';
import { useUploads } from './useUploads';
import { formatBytes } from '../../lib/files';

const TYPING_EVERY_MS = 3000;
const drafts = new Map<string, string>();

export function Composer({ ctx, replyTo, onClearReply }: { ctx: ChatContext; replyTo: ClientMessage | null; onClearReply: () => void }) {
  const { channelId } = ctx;
  const [value, setValue] = useState(() => drafts.get(channelId) ?? '');
  const [suggest, setSuggest] = useState<{ query: string; start: number; index: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  const announcement = ctx.channel?.type === 'announcement';
  const canSend = can(ctx.perms, P.SEND_MESSAGES) && (!announcement || can(ctx.perms, P.MANAGE_MESSAGES));
  const canAttach = canSend && can(ctx.perms, P.ATTACH_FILES);
  const uploads = useUploads(channelId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const addFiles = (files: FileList | File[]) => {
    if (!canAttach) return setAttachNote('Você não pode enviar arquivos neste canal.');
    const left = uploads.add(files);
    setAttachNote(left > 0 ? `No máximo 10 anexos por mensagem; ${left} ficou de fora.` : null);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  // Rascunho por canal: trocar de canal não perde o que estava sendo escrito.
  useEffect(() => {
    setValue(drafts.get(channelId) ?? '');
    ref.current?.focus();
  }, [channelId]);
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  // Altura automática até um limite.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const selfId = useSession((s) => s.user?.id);
  const candidates: PublicUser[] = suggest
    ? ctx.users
        .filter((u) => u.id !== selfId)
        .filter((u) => {
          const q = suggest.query.toLowerCase();
          return formatTag(u).toLowerCase().startsWith(q) || u.displayName.toLowerCase().startsWith(q);
        })
        .slice(0, 8)
    : [];

  const update = (text: string, caret: number) => {
    setValue(text);
    drafts.set(channelId, text);
    const before = text.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}_.-]{0,32}(?:#\d{0,5})?)$/u.exec(before);
    setSuggest(m ? { query: m[2]!, start: caret - m[2]!.length - 1, index: 0 } : null);
    if (text && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
      lastTyping.current = Date.now();
      sendTyping(channelId);
    }
  };

  const pick = (u: PublicUser) => {
    if (!suggest) return;
    const el = ref.current!;
    const caret = el.selectionStart;
    const tag = formatTag(u);
    const next = `${value.slice(0, suggest.start)}@${tag} ${value.slice(caret)}`;
    setValue(next);
    drafts.set(channelId, next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const pos = suggest.start + tag.length + 2;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const send = () => {
    const content = encodeMentions(value, ctx.users).trim();
    // Espera os anexos terminarem de subir: enviar sem eles surpreenderia quem escreveu.
    if (uploads.uploading || content.length > MESSAGE_MAX_LENGTH) return;
    if (!content && uploads.ready === 0) return;
    void useMessages.getState().send(channelId, content, replyTo?.id, uploads.take());
    setAttachNote(null);
    setValue('');
    drafts.delete(channelId);
    onClearReply();
    lastTyping.current = 0;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && candidates.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSuggest({ ...suggest, index: (suggest.index + d + candidates.length) % candidates.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(candidates[suggest.index]!);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (suggest) setSuggest(null);
      else if (replyTo) onClearReply();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!canSend) {
    return (
      <div className="composer composer--locked" role="note">
        <Lock size={16} aria-hidden />
        {announcement ? 'Só moderadores publicam neste canal de anúncios.' : 'Você não tem permissão para enviar mensagens neste canal.'}
      </div>
    );
  }

  const remaining = MESSAGE_MAX_LENGTH - value.length;
  const canSubmit = (!!value.trim() || uploads.ready > 0) && remaining >= 0 && !uploads.uploading;
  return (
    <div
      className={`composer-wrap ${dragging ? 'composer-wrap--drop' : ''}`}
      onDragOver={(e) => {
        if (canAttach && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <TypingIndicator ctx={ctx} />
      {replyTo && (
        <div className="composer__reply">
          <span>
            Respondendo a <strong>{replyTo.author.displayName}</strong>
          </span>
          <button className="icon-btn icon-btn--xs" aria-label="Cancelar resposta" onClick={onClearReply}>
            <X size={14} />
          </button>
        </div>
      )}
      {suggest && candidates.length > 0 && (
        <ul className="popover mention-list" role="listbox" aria-label="Mencionar">
          {candidates.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === suggest.index}>
              <button className={`mention-list__item ${i === suggest.index ? 'mention-list__item--on' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(u); }}>
                <Avatar name={u.displayName} seed={u.id} imageId={u.avatarId} size={24} />
                <strong>{u.displayName}</strong> <span className="muted">{formatTag(u)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploads.items.length > 0 && (
        <ul className="uploads" aria-label="Anexos">
          {uploads.items.map((u) => (
            <li key={u.key} className={`upload upload--${u.status}`}>
              {u.preview ? <img src={u.preview} alt="" className="upload__thumb" /> : <FileText size={28} aria-hidden className="upload__thumb" />}
              <span className="upload__name" title={u.name}>
                {u.name}
              </span>
              <span className="upload__meta">
                {u.status === 'uploading' ? `Enviando… ${Math.round(u.progress * 100)}%` : u.status === 'error' ? u.error : formatBytes(u.size)}
              </span>
              {u.status === 'uploading' && <progress className="upload__bar" max={1} value={u.progress} aria-label={`Progresso de ${u.name}`} />}
              <button className="icon-btn icon-btn--xs upload__remove" aria-label={`Remover ${u.name}`} onClick={() => uploads.remove(u.key)}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachNote && <p className="composer__note">{attachNote}</p>}
      <div className={`composer ${replyTo ? 'composer--replying' : ''}`}>
        {canAttach && (
          <>
            <button className="icon-btn" aria-label="Anexar arquivos" onClick={() => fileInput.current?.click()}>
              <Paperclip size={18} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={value}
          placeholder={ctx.kind === 'dm' ? `Conversar com @${ctx.title}` : `Conversar em #${ctx.title}`}
          aria-label="Escrever mensagem"
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={() => setTimeout(() => setSuggest(null), 100)}
        />
        {remaining < 200 && <span className={`composer__count ${remaining < 0 ? 'composer__count--over' : ''}`}>{remaining}</span>}
        <button className="icon-btn" aria-label={uploads.uploading ? 'Aguardando anexos' : 'Enviar'} onClick={send} disabled={!canSubmit}>
          <SendHorizontal size={18} />
        </button>
      </div>
    </div>
  );
}

function TypingIndicator({ ctx }: { ctx: ChatContext }) {
  const typing = useMessages((s) => s.typing[ctx.channelId]);
  const selfId = useSession((s) => s.user?.id);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!typing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [typing]);
  const names = Object.entries(typing ?? {})
    .filter(([id, until]) => until > now && id !== selfId)
    .map(([id]) => ctx.users.find((u) => u.id === id)?.displayName ?? 'Alguém');
  const text =
    names.length === 0 ? '' : names.length === 1 ? `${names[0]} está digitando…` : names.length <= 3 ? `${names.join(', ')} estão digitando…` : 'Várias pessoas estão digitando…';
  return (
    <div className="typing" aria-live="polite">
      {text && <><span className="typing__dots" aria-hidden><i /><i /><i /></span>{text}</>}
    </div>
  );
}
