import { useEffect, useRef, useState } from 'react';
import { Permission as P, type Channel } from '@nexo/protocol';
import { ChevronDown, FolderPlus, Hash, LogOut, Megaphone, Plus, Settings, UserPlus, Volume2, X } from 'lucide-react';
import { Tooltip, useFocusTrap } from './ui';
import { UserPanel } from './UserPanel';
import { isUnread, useMessages } from '../stores/messages';
import { useNav } from '../stores/nav';
import { can, sortChannels, useServers } from '../stores/servers';
import { api, useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { describeError } from '../services/api';
import { ConfirmDialog } from './ConfirmDialog';
import { VoiceRoster } from './voice/VoiceBits';
import { useUserMap } from './voice/useUserMap';
import { useVoice } from '../stores/voice';
import { voice } from '../voice/controller';
import { unreadMentions, useNotify } from '../lib/notify/engine';
import { isMuted } from '../lib/notify/rules';
import { useSettings } from '../stores/settings';

export const channelIcon = (type: Channel['type'], size = 18) =>
  type === 'voice' ? <Volume2 size={size} aria-hidden /> : type === 'announcement' ? <Megaphone size={size} aria-hidden /> : <Hash size={size} aria-hidden />;

export function ServerSidebar({ serverId }: { serverId: string }) {
  const detail = useServers((s) => s.details[serverId]);
  const route = useNav((s) => s.route);
  const collapsed = useNav((s) => s.collapsed);
  const last = useMessages((s) => s.lastMessageId);
  const read = useMessages((s) => s.readStates);
  const openModal = useUi((s) => s.openModal);
  const [menuOpen, setMenuOpen] = useState(false);
  const voiceChannel = useVoice((s) => s.channelId);
  const users = useUserMap();
  const mentionIds = useNotify((s) => s.mentionIds);
  const settings = useSettings((s) => s.settings);
  const mentionCounts = unreadMentions(mentionIds, read);
  const hasMembers = useServers((s) => !!s.members[serverId]);
  useEffect(() => {
    // Nomes de quem está em voz vêm da lista de membros.
    if (!hasMembers) void useServers.getState().loadMembers(serverId).catch(() => {});
  }, [hasMembers, serverId]);

  if (!detail) {
    return (
      <aside className="sidebar" aria-label="Canais" aria-busy>
        <header className="sidebar__header" />
        <div className="sidebar__scroll" />
        <UserPanel />
      </aside>
    );
  }

  const manage = can(detail.myPermissions, P.MANAGE_CHANNELS);
  const activeId = route.kind === 'server' ? route.channelId : null;
  const open = (c: Channel) => {
    useNav.getState().go({ kind: 'server', serverId, channelId: c.id });
    useUi.getState().toggleSidebar(false);
    // Clicar num canal de voz entra na sala (se houver permissão), como esperado em apps de voz.
    if (c.type === 'voice' && can(c.myPermissions, P.CONNECT_VOICE) && useVoice.getState().channelId !== c.id) void voice.join(c.id);
  };

  return (
    <aside className="sidebar" aria-label={`Canais de ${detail.server.name}`}>
      <header className="sidebar__header sidebar__header--server">
        <button className="server-header" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
          <span className="server-header__name">{detail.server.name}</span>
          {menuOpen ? <X size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
        </button>
        {menuOpen && <ServerMenu serverId={serverId} onClose={() => setMenuOpen(false)} />}
      </header>
      <div className="sidebar__scroll">
        {sortChannels(detail.channels).map(({ category, channels }) => {
          const isCollapsed = category ? !!collapsed[category.id] : false;
          return (
            <section key={category?.id ?? 'root'} className="channel-group">
              {category && (
                <div className="channel-group__head">
                  <button
                    className="channel-group__toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() => useNav.getState().toggleCategory(category.id)}
                  >
                    <ChevronDown size={12} className={isCollapsed ? 'rot-90' : ''} aria-hidden />
                    {category.name}
                  </button>
                  {manage && (
                    <Tooltip label="Criar canal">
                      <button
                        className="icon-btn icon-btn--xs"
                        aria-label={`Criar canal em ${category.name}`}
                        onClick={() => openModal({ kind: 'createChannel', serverId, parentId: category.id })}
                      >
                        <Plus size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              )}
              <ul className="channel-list">
                {channels
                  // Categoria recolhida ainda mostra o canal aberto e os com novidades.
                  .filter((c) => !isCollapsed || c.id === activeId || isUnread(last[c.id], read[c.id]))
                  .map((c) => {
                    const muted = c.type !== 'voice' && isMuted(settings, serverId, c.id, Date.now());
                    // Silenciado: sem destaque de não lidas (menções continuam contadas).
                    const unread = c.type !== 'voice' && !muted && isUnread(last[c.id], read[c.id]);
                    const mentionCount = mentionCounts[c.id] ?? 0;
                    const active = c.id === activeId;
                    const canEdit = can(c.myPermissions, P.MANAGE_CHANNELS) || can(c.myPermissions, P.MANAGE_ROLES);
                    return (
                      <li key={c.id} className="channel-item">
                        {c.type === 'voice' ? (
                          <button
                            className={`channel channel--voice ${active ? 'channel--active' : ''} ${voiceChannel === c.id ? 'channel--in-voice' : ''}`}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => open(c)}
                          >
                            {channelIcon(c.type)}
                            <span className="channel__name">{c.name}</span>
                          </button>
                        ) : (
                          <button
                            className={`channel ${active ? 'channel--active' : ''} ${unread ? 'channel--unread' : ''} ${muted ? 'channel--muted' : ''}`}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => open(c)}
                          >
                            {unread && <span className="channel__unread" aria-hidden />}
                            {channelIcon(c.type)}
                            <span className="channel__name">{c.name}</span>
                            {unread && <span className="sr-only">(não lido)</span>}
                            {muted && <span className="sr-only">(silenciado)</span>}
                            {mentionCount > 0 && (
                              <span className="mention-badge" aria-label={`${mentionCount} ${mentionCount === 1 ? 'menção' : 'menções'}`}>
                                {mentionCount > 99 ? '99+' : mentionCount}
                              </span>
                            )}
                          </button>
                        )}
                        {canEdit && (
                          <button
                            className="channel__gear"
                            aria-label={`Configurar ${c.name}`}
                            onClick={() => openModal({ kind: 'channelSettings', serverId, channelId: c.id })}
                          >
                            <Settings size={14} />
                          </button>
                        )}
                        {c.type === 'voice' && <VoiceRoster channelId={c.id} users={users} />}
                      </li>
                    );
                  })}
              </ul>
            </section>
          );
        })}
      </div>
      <UserPanel />
    </aside>
  );
}

function ServerMenu({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const detail = useServers((s) => s.details[serverId])!;
  const me = useSession((s) => s.user?.id);
  const ref = useRef<HTMLDivElement>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  useFocusTrap(ref, onClose);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onDown));
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const perms = detail.myPermissions;
  const isOwner = detail.server.ownerId === me;
  const canSettings = [P.MANAGE_SERVER, P.MANAGE_ROLES, P.KICK_MEMBERS, P.MANAGE_INVITES, P.VIEW_AUDIT_LOG].some((b) => can(perms, b));
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const { openModal } = useUi.getState();

  if (confirmLeave) {
    return (
      <ConfirmDialog
        title={`Sair de ${detail.server.name}?`}
        confirmLabel="Sair do servidor"
        danger
        onCancel={onClose}
        onConfirm={async () => {
          await api.leaveServer(serverId).catch((e) => {
            throw new Error(describeError(e));
          });
          useServers.getState().remove(serverId);
          onClose();
        }}
      >
        Você só poderá voltar com um novo convite.
      </ConfirmDialog>
    );
  }

  return (
    <div ref={ref} className="popover server-menu" role="menu">
      {can(perms, P.CREATE_INVITES) && (
        <MenuItem icon={<UserPlus size={16} />} label="Convidar pessoas" accent onClick={act(() => openModal({ kind: 'invite', serverId }))} />
      )}
      {canSettings && <MenuItem icon={<Settings size={16} />} label="Configurações do servidor" onClick={act(() => openModal({ kind: 'serverSettings', serverId }))} />}
      {can(perms, P.MANAGE_CHANNELS) && (
        <>
          <MenuItem icon={<Plus size={16} />} label="Criar canal" onClick={act(() => openModal({ kind: 'createChannel', serverId, parentId: null }))} />
          <MenuItem
            icon={<FolderPlus size={16} />}
            label="Criar categoria"
            onClick={act(() => openModal({ kind: 'createChannel', serverId, parentId: null, type: 'category' }))}
          />
        </>
      )}
      {!isOwner && (
        <>
          <div className="popover__sep" />
          <MenuItem icon={<LogOut size={16} />} label="Sair do servidor" danger onClick={() => setConfirmLeave(true)} />
        </>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger, accent }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; accent?: boolean }) {
  return (
    <button role="menuitem" className={`menu-item ${danger ? 'menu-item--danger' : ''} ${accent ? 'menu-item--accent' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {icon}
    </button>
  );
}
