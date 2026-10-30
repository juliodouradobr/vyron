import { useEffect, useState } from 'react';
import { AtSign, Menu, Phone, Search, Users } from 'lucide-react';
import { CallStrip } from '../../components/voice/CallStrip';
import { useVoice } from '../../stores/voice';
import { voice } from '../../voice/controller';
import { IconButton, Spinner } from '../../components/ui';
import { ConnectionBanner } from '../../components/ConnectionIndicator';
import { MemberList } from '../../components/MemberList';
import { channelIcon } from '../../components/ServerSidebar';
import type { ClientMessage } from '../../stores/messages';
import { useNav, type Route } from '../../stores/nav';
import { useUi } from '../../stores/ui';
import { useServers } from '../../stores/servers';
import { NotifyMenu } from '../../components/NotifyMenu';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { SearchPanel } from './SearchPanel';
import { useChatContext } from './useChatContext';

export function ChatView({ route }: { route: Route }) {
  const ctx = useChatContext(route);
  const memberListOpen = useNav((s) => s.memberListOpen);
  const [replyTo, setReplyTo] = useState<ClientMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const channelId = ctx?.channelId;
  const inCall = useVoice((s) => !!channelId && s.channelId === channelId);

  useEffect(() => {
    setReplyTo(null);
    setSearchOpen(false);
  }, [channelId]);

  if (!ctx) {
    return (
      <main className="main main--center" aria-busy>
        {route.kind === 'server' && !route.channelId ? <p className="muted">Este servidor ainda não tem canais de texto que você possa ver.</p> : <Spinner />}
      </main>
    );
  }

  const showMembers = ctx.kind === 'server' && memberListOpen;
  return (
    <main className="main chat" aria-label={ctx.kind === 'dm' ? `Conversa com ${ctx.title}` : `Canal ${ctx.title}`}>
      <header className="main__header">
        <IconButton label="Abrir canais" className="main__menu" onClick={() => useUi.getState().toggleSidebar(true)} tooltipSide="bottom">
          <Menu size={20} />
        </IconButton>
        <span className="main__header-icon">{ctx.channel ? channelIcon(ctx.channel.type, 20) : <AtSign size={20} aria-hidden />}</span>
        <h1>{ctx.title}</h1>
        {ctx.topic && (
          <>
            <span className="main__divider" aria-hidden />
            <p className="main__topic" title={ctx.topic}>{ctx.topic}</p>
          </>
        )}
        <div className="main__actions">
          {ctx.kind === 'dm' && (
            <IconButton
              label={inCall ? 'Você está nesta chamada' : 'Iniciar chamada de voz'}
              active={inCall}
              disabled={inCall}
              onClick={() => void voice.call(ctx.channelId)}
              tooltipSide="bottom"
            >
              <Phone size={18} />
            </IconButton>
          )}
          <NotifyMenu
            channelId={ctx.channelId}
            channelName={ctx.title}
            serverId={ctx.serverId}
            serverName={ctx.serverId ? useServers.getState().details[ctx.serverId]?.server.name : undefined}
          />
          <IconButton label="Buscar neste canal" active={searchOpen} onClick={() => setSearchOpen((v) => !v)} tooltipSide="bottom">
            <Search size={18} />
          </IconButton>
          {ctx.kind === 'server' && (
            <IconButton label={memberListOpen ? 'Ocultar membros' : 'Mostrar membros'} active={memberListOpen} onClick={() => useNav.getState().toggleMemberList()} tooltipSide="bottom">
              <Users size={18} />
            </IconButton>
          )}
        </div>
      </header>
      <ConnectionBanner />
      <div className="chat__body">
        <div className="chat__col">
          {ctx.kind === 'dm' && <CallStrip channelId={ctx.channelId} recipientName={ctx.title} />}
          <MessageList ctx={ctx} onReply={setReplyTo} />
          <Composer ctx={ctx} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
        </div>
        {searchOpen ? <SearchPanel ctx={ctx} onClose={() => setSearchOpen(false)} /> : showMembers && ctx.serverId && <MemberList serverId={ctx.serverId} />}
      </div>
    </main>
  );
}
