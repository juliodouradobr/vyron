import { lazy, Suspense, useEffect, useState } from 'react';
import { Banner, Button, Spinner } from '../components/ui';
import { HomeSidebar } from '../components/HomeSidebar';
import { RecoveryCodesDialog } from '../components/RecoveryCodesDialog';
import { ServerRail } from '../components/ServerRail';
import { ServerSidebar } from '../components/ServerSidebar';
import { ChatView } from '../pages/chat/ChatView';
import { FriendsView } from '../pages/FriendsView';
import { HomeView } from '../pages/HomeView';
import { VoiceRoomView } from '../pages/VoiceRoomView';
import { IncomingCall } from '../components/voice/IncomingCall';
import { describeError } from '../services/api';
import { loadInitialState, startRealtime, stopRealtime } from '../services/realtime';
import { startTitleBadge } from '../lib/notify/engine';
import { useNav } from '../stores/nav';
import { firstTextChannel, useServers } from '../stores/servers';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';
import { useSocial } from '../stores/social';
import { useUi } from '../stores/ui';

// Telas pesadas e pouco usadas carregam sob demanda: não pesam na abertura do app.
const SettingsModal = lazy(() => import('../pages/settings/SettingsModal'));
const ModalHost = lazy(() => import('../components/modals/ModalHost'));

export function AppShell() {
  const codes = useSession((s) => s.pendingRecoveryCodes);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const modal = useUi((s) => s.modal);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const route = useNav((s) => s.route);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    loadInitialState().catch((e) => setLoadError(describeError(e)));
  };

  useEffect(() => {
    startRealtime();
    void useSettings.getState().load();
    load();
    const stopBadge = startTitleBadge();
    return () => {
      stopBadge();
      stopRealtime();
    };
  }, []);

  // Rota salva que deixou de valer (servidor removido, DM inexistente) volta para Amigos.
  const serversLoaded = useServers((s) => s.loaded);
  const socialLoaded = useSocial((s) => s.loaded);
  const known = useServers((s) => (route.kind === 'server' ? s.details[route.serverId] : undefined));
  const dmKnown = useSocial((s) => (route.kind === 'dm' ? !!s.dms[route.channelId] : true));
  const voiceChannel = route.kind === 'server' ? known?.channels.find((c) => c.id === route.channelId && c.type === 'voice') : undefined;
  useEffect(() => {
    if (route.kind === 'server' && serversLoaded && !known) useNav.getState().go({ kind: 'friends' });
    if (route.kind === 'server' && known && !route.channelId) {
      const first = firstTextChannel(known);
      if (first) useNav.getState().go({ kind: 'server', serverId: route.serverId, channelId: first.id });
    }
    if (route.kind === 'dm' && socialLoaded && !dmKnown) useNav.getState().go({ kind: 'friends' });
  }, [route, serversLoaded, known, socialLoaded, dmKnown]);

  return (
    <div className={`shell ${sidebarOpen ? 'shell--sidebar-open' : ''}`}>
      <ServerRail />
      {route.kind === 'server' ? <ServerSidebar serverId={route.serverId} /> : <HomeSidebar />}
      {sidebarOpen && <div className="shell__scrim" onClick={() => toggleSidebar(false)} aria-hidden />}
      {loadError ? (
        <main className="main main--center">
          <Banner tone="error">Não foi possível carregar seus dados: {loadError}</Banner>
          <Button onClick={load}>Tentar novamente</Button>
        </main>
      ) : route.kind === 'friends' ? (
        <FriendsView />
      ) : route.kind === 'home' ? (
        <HomeView />
      ) : route.kind === 'server' && voiceChannel ? (
        <VoiceRoomView serverId={route.serverId} channel={voiceChannel} />
      ) : (
        <ChatView route={route} />
      )}
      <IncomingCall />
      {settingsOpen && (
        <Suspense fallback={<div className="modal-backdrop"><Spinner /></div>}>
          <SettingsModal />
        </Suspense>
      )}
      {modal && (
        <Suspense fallback={<div className="modal-backdrop"><Spinner /></div>}>
          <ModalHost />
        </Suspense>
      )}
      {codes && <RecoveryCodesDialog codes={codes} onDone={() => useSession.getState().showRecoveryCodes(null)} />}
    </div>
  );
}
