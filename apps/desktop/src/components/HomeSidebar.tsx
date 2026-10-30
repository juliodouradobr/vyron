import { Gamepad2, House, Users } from 'lucide-react';
import { Avatar } from './ui';
import { UserPanel } from './UserPanel';
import { isUnread, useMessages } from '../stores/messages';
import { useNav } from '../stores/nav';
import { presenceOf, useSocial } from '../stores/social';
import { useUi } from '../stores/ui';

/** Painel de conversas do Início: navegação pessoal + mensagens diretas. */
export function HomeSidebar() {
  const route = useNav((s) => s.route);
  const go = useNav((s) => s.go);
  const dms = useSocial((s) => s.dms);
  const presences = useSocial((s) => s.presences);
  const pending = useSocial((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);
  const last = useMessages((s) => s.lastMessageId);
  const read = useMessages((s) => s.readStates);
  const close = () => useUi.getState().toggleSidebar(false);

  // Conversas mais recentes primeiro (UUIDv7 ordena por tempo).
  const sorted = Object.values(dms).sort((a, b) => ((last[b.id] ?? '') > (last[a.id] ?? '') ? 1 : -1));

  return (
    <aside className="sidebar" aria-label="Conversas">
      <header className="sidebar__header">
        <span className="sidebar__title">Mensagens</span>
      </header>
      <div className="sidebar__scroll">
        <nav aria-label="Início">
          <SidebarLink icon={<Users size={18} />} label="Amigos" active={route.kind === 'friends'} count={pending} onClick={() => { go({ kind: 'friends' }); close(); }} />
          <SidebarLink icon={<House size={18} />} label="Visão geral" active={route.kind === 'home'} onClick={() => { go({ kind: 'home' }); close(); }} />
          <SidebarLink icon={<Gamepad2 size={18} />} label="Jogar Juntos" badge="Etapa 6" disabled />
        </nav>
        <div className="sidebar__section">
          <span>Mensagens diretas</span>
        </div>
        {sorted.length === 0 ? (
          <p className="sidebar__empty">Abra uma conversa pela lista de amigos ou pelo perfil de alguém.</p>
        ) : (
          <ul className="dm-list">
            {sorted.map((dm) => {
              const unread = isUnread(last[dm.id], read[dm.id]);
              const active = route.kind === 'dm' && route.channelId === dm.id;
              return (
                <li key={dm.id}>
                  <button
                    className={`side-link side-link--dm ${active ? 'side-link--active' : ''} ${unread ? 'side-link--unread' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => { go({ kind: 'dm', channelId: dm.id }); close(); }}
                  >
                    <Avatar name={dm.recipient.displayName} seed={dm.recipient.id} imageId={dm.recipient.avatarId} size={32} status={presenceOf(presences, dm.recipient.id)} />
                    <span className="side-link__name">{dm.recipient.displayName}</span>
                    {unread && <span className="unread-dot" aria-label="não lida" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <UserPanel />
    </aside>
  );
}

function SidebarLink({
  icon,
  label,
  active,
  disabled,
  badge,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  count?: number;
  onClick?: () => void;
}) {
  return (
    <button className={`side-link ${active ? 'side-link--active' : ''}`} aria-current={active ? 'page' : undefined} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {badge && <span className="side-link__badge">{badge}</span>}
      {!!count && <span className="count-badge" aria-label={`${count} pendente(s)`}>{count}</span>}
    </button>
  );
}
