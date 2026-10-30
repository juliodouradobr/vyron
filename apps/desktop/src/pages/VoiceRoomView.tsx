import { useEffect } from 'react';
import { Permission as P, VOICE_MAX_PARTICIPANTS, type Channel } from '@nexo/protocol';
import { Menu, Mic, PhoneOff, Volume2 } from 'lucide-react';
import { Banner, Button, IconButton } from '../components/ui';
import { ConnectionBanner } from '../components/ConnectionIndicator';
import { VoiceTiles } from '../components/voice/VoiceTiles';
import { StreamStage } from '../components/voice/ScreenShare';
import { useUserMap } from '../components/voice/useUserMap';
import { voice } from '../voice/controller';
import { can, useServers } from '../stores/servers';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';

/** Sala de voz de um servidor: quem está nela e o botão de entrar/sair. */
export function VoiceRoomView({ serverId, channel }: { serverId: string; channel: Channel }) {
  const users = useUserMap();
  const members = useServers((s) => s.members[serverId]);
  const room = useVoice((s) => s.rooms[channel.id]);
  const mine = useVoice((s) => s.channelId === channel.id);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const count = Object.keys(room ?? {}).length;
  const canConnect = can(channel.myPermissions, P.CONNECT_VOICE);
  const canSpeak = can(channel.myPermissions, P.SPEAK);

  useEffect(() => {
    if (!members) void useServers.getState().loadMembers(serverId).catch(() => {});
  }, [members, serverId]);

  return (
    <main className="main voice-room" aria-label={`Sala de voz ${channel.name}`}>
      <header className="main__header">
        <IconButton label="Abrir canais" className="main__menu" onClick={() => useUi.getState().toggleSidebar(true)} tooltipSide="bottom">
          <Menu size={20} />
        </IconButton>
        <Volume2 size={20} className="main__header-icon" aria-hidden />
        <h1>{channel.name}</h1>
        <span className="main__divider" aria-hidden />
        <p className="main__topic">
          {count}/{VOICE_MAX_PARTICIPANTS} pessoas
        </p>
      </header>
      <ConnectionBanner />
      <div className="voice-room__body">
        <StreamStage channelId={channel.id} users={users} />
        {count > 0 ? (
          <VoiceTiles channelId={channel.id} users={users} />
        ) : (
          <div className="empty">
            <Volume2 size={48} aria-hidden />
            <p>Ninguém está nesta sala agora.</p>
          </div>
        )}
        {error && !mine && <Banner tone="error">{error}</Banner>}
        {!canSpeak && canConnect && <Banner tone="info">Você pode ouvir nesta sala, mas não tem permissão para falar.</Banner>}
        <div className="voice-room__actions">
          {mine ? (
            <Button variant="danger" size="lg" onClick={() => voice.leave()}>
              <PhoneOff size={18} aria-hidden /> Sair da sala
            </Button>
          ) : (
            <Button size="lg" onClick={() => void voice.join(channel.id)} disabled={!canConnect || count >= VOICE_MAX_PARTICIPANTS} loading={status === 'connecting' && mine}>
              <Mic size={18} aria-hidden /> {canConnect ? 'Entrar na sala' : 'Sem permissão para entrar'}
            </Button>
          )}
        </div>
        <p className="field__hint voice-room__privacy">
          Chamadas são diretas entre os participantes (P2P, criptografadas com DTLS-SRTP). Sem a opção "Ocultar meu IP",
          quem está na sala pode ver o seu endereço IP. Nada é gravado.
        </p>
      </div>
    </main>
  );
}
