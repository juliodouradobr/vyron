import { useState } from 'react';
import { Bell, Compass, Plus } from 'lucide-react';
import type { ServerDetail } from '@nexo/protocol';
import { Logo, Tooltip } from './ui';
import { isUnread, useMessages } from '../stores/messages';
import { firstTextChannel, useServers } from '../stores/servers';
import { useNav } from '../stores/nav';
import { useSocial } from '../stores/social';
import { useUi } from '../stores/ui';
import { InboxModal, useUnreadMentionTotal } from './Inbox';
import { unreadMentions, useNotify } from '../lib/notify/engine';
import { muteActive } from '../lib/notify/rules';
import { useSettings } from '../stores/settings';

export const serverInitials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => [...w][0])
    .join('')
    .toUpperCase();

function useServerUnread(detail: ServerDetail | undefined): boolean {
  const last = useMessages((s) => s.lastMessageId);
  const read = useMessages((s) => s.readStates);
  if (!detail) return false;
  return detail.channels.some((c) => (c.type === 'text' || c.type === 'announcement') && isUnread(last[c.id], read[c.id]));
}

export function ServerRail() {
  const route = useNav((s) => s.route);
  const list = useServers((s) => s.list);
  const openModal = useUi((s) => s.openModal);
  const pending = useSocial((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);
  const dms = useSocial((s) => s.dms);
  const last = useMessages((s) => s.lastMessageId);
  const read = useMessages((s) => s.readStates);
  const dmUnread = Object.keys(dms).some((id) => isUnread(last[id], read[id]));
  const homeActive = route.kind !== 'server';
  const mentions = useUnreadMentionTotal();
  const [inbox, setInbox] = useState(false);

  return (
    <nav className="rail" aria-label="Servidores">
      <RailItem
        label="Mensagens diretas e amigos"
        active={homeActive}
        unread={dmUnread && !homeActive}
        badge={pending || undefined}
        onClick={() => useNav.getState().go({ kind: 'friends' })}
      >
        <Logo size={28} />
      </RailItem>
      <RailItem label={mentions ? `Caixa de entrada (${mentions} ${mentions === 1 ? 'menção não lida' : 'menções não lidas'})` : 'Caixa de entrada'} variant="action" badge={mentions || undefined} onClick={() => setInbox(true)}>
        <Bell size={20} />
      </RailItem>
      <div className="rail__sep" role="separator" />
      <ul className="rail__list" aria-label="Seus servidores">
        {list.map((s) => (
          <ServerItem key={s.id} id={s.id} name={s.name} active={route.kind === 'server' && route.serverId === s.id} />
        ))}
      </ul>
      <RailItem label="Adicionar um servidor" variant="action" onClick={() => openModal({ kind: 'addServer' })}>
        <Plus size={22} />
      </RailItem>
      <RailItem label="Explorar comunidades — em breve" variant="action" disabled>
        <Compass size={22} />
      </RailItem>
      {inbox && <InboxModal onClose={() => setInbox(false)} />}
    </nav>
  );
}

function ServerItem({ id, name, active }: { id: string; name: string; active: boolean }) {
  const detail = useServers((s) => s.details[id]);
  const unread = useServerUnread(detail);
  // Menções não lidas nos canais deste servidor (número no ícone); silenciado = sem destaque de não lidas.
  const mentionIds = useNotify((s) => s.mentionIds);
  const read = useMessages((s) => s.readStates);
  const muted = useSettings((s) => muteActive(s.settings.mutedServers[id], Date.now()));
  const counts = unreadMentions(mentionIds, read);
  const mentions = detail ? detail.channels.reduce((n, c) => n + (counts[c.id] ?? 0), 0) : 0;
  const open = () => {
    const nav = useNav.getState();
    const last = nav.lastChannel[id];
    const channelId = detail?.channels.some((c) => c.id === last) ? last! : detail ? (firstTextChannel(detail)?.id ?? null) : null;
    nav.go({ kind: 'server', serverId: id, channelId });
  };
  return (
    <li>
      <RailItem label={muted ? `${name} (silenciado)` : name} active={active} unread={unread && !active && !muted} badge={mentions || undefined} muted={muted} onClick={open}>
        <span className="rail__initials">{serverInitials(name)}</span>
      </RailItem>
    </li>
  );
}

function RailItem({
  label,
  active,
  disabled,
  unread,
  badge,
  muted,
  variant = 'server',
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  unread?: boolean;
  badge?: number;
  muted?: boolean;
  variant?: 'server' | 'action';
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rail__item ${active ? 'rail__item--active' : ''} ${unread ? 'rail__item--unread' : ''} ${muted ? 'rail__item--muted' : ''}`}>
      <span className="rail__pill" aria-hidden />
      <Tooltip label={label} side="right">
        <button
          className={`rail__btn rail__btn--${variant}`}
          aria-label={unread ? `${label} (mensagens não lidas)` : label}
          aria-current={active ? 'page' : undefined}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
          {badge ? <span className="rail__badge">{badge > 99 ? '99+' : badge}</span> : null}
        </button>
      </Tooltip>
    </div>
  );
}
