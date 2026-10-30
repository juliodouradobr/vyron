import { useState } from 'react';
import { Activity, MonitorUp, MonitorX, PhoneOff, Signal, X } from 'lucide-react';
import { IconButton } from '../ui';
import { VoiceDiagnostics } from './VoiceDiagnostics';
import { ScreenShareDialog, useCanStream } from './ScreenShare';
import { CameraButton } from './Camera';
import { useUserMap } from './useUserMap';
import { describeSurface } from '../../voice/screen/quality';
import { useSession } from '../../stores/session';
import { quality } from '../../voice/adaptation';
import { voice } from '../../voice/controller';
import { useNav } from '../../stores/nav';
import { useServers } from '../../stores/servers';
import { useSocial } from '../../stores/social';
import { useVoice } from '../../stores/voice';

const NOISE_LABEL: Record<string, string> = {
  strong: 'Forte',
  balanced: 'Equilibrado',
  light: 'Leve',
  natural: 'Natural',
  economy: 'Economia',
  off: 'desativado',
  loading: 'carregando…',
};

/** Faixa acima da barra do usuário enquanto há uma chamada (ou erro/aviso de voz). */
export function VoicePanel() {
  const { channelId, status, error, notice, peers, noise } = useVoice();
  const details = useServers((s) => s.details);
  const dms = useSocial((s) => s.dms);
  const [diag, setDiag] = useState(false);
  const [share, setShare] = useState(false);
  const screen = useVoice((s) => s.screen);
  const selfId = useSession((s) => s.user?.id ?? '');
  const viewers = useVoice((s) => (s.channelId ? (s.rooms[s.channelId]?.[selfId]?.stream?.viewers.length ?? 0) : 0));
  const canStream = useCanStream();
  const control = useVoice((s) => (s.channelId ? s.rooms[s.channelId]?.[selfId]?.stream?.control : null)) ?? null;
  const requests = useVoice((s) => s.playRequests.length);
  const users = useUserMap();

  if (!channelId && !error && !notice) return null;

  const dm = channelId ? dms[channelId] : undefined;
  const server = channelId ? Object.values(details).find((d) => d.channels.some((c) => c.id === channelId)) : undefined;
  const channel = server?.channels.find((c) => c.id === channelId);
  const where = dm ? `Chamada com ${dm.recipient.displayName}` : channel && server ? `${channel.name} / ${server.server.name}` : '';

  const samples = Object.values(peers).filter((p) => p.rttMs != null);
  const worst = samples.length
    ? quality({ loss: Math.max(...samples.map((p) => p.loss ?? 0)), jitterMs: Math.max(...samples.map((p) => p.jitterMs ?? 0)), rttMs: Math.max(...samples.map((p) => p.rttMs ?? 0)) })
    : null;
  const ping = samples.length ? Math.max(...samples.map((p) => p.rttMs ?? 0)) : null;

  const goToRoom = () => {
    if (!channelId) return;
    if (dm) useNav.getState().go({ kind: 'dm', channelId });
    else if (server) useNav.getState().go({ kind: 'server', serverId: server.server.id, channelId });
  };

  return (
    <section className="voice-panel" aria-label="Conexão de voz">
      {(error || notice) && (
        <div className={`voice-panel__msg ${error ? 'voice-panel__msg--error' : ''}`} role={error ? 'alert' : 'status'}>
          <span>{error ?? notice}</span>
          <button className="icon-btn icon-btn--xs" aria-label="Dispensar aviso" onClick={() => useVoice.getState().patch({ error: null, notice: null })}>
            <X size={12} />
          </button>
        </div>
      )}
      {channelId && (
        <div className="voice-panel__row">
          <button className="voice-panel__info" onClick={goToRoom}>
            <span className={`voice-panel__status voice-panel__status--${status === 'connected' ? worst ?? 'good' : 'connecting'}`}>
              <Signal size={14} aria-hidden />
              {status === 'connected' ? 'Voz conectada' : 'Conectando…'}
              {status === 'connected' && ping != null && <span className="muted"> · {ping} ms</span>}
            </span>
            <span className="voice-panel__where">{where}</span>
            {noise && status === 'connected' && (
              <span className="voice-panel__noise">
                Ruído: {NOISE_LABEL[noise.applied] ?? noise.applied}
                {noise.mode === 'auto' && noise.applied !== 'loading' ? ' (auto)' : ''}
                {noise.noiseReductionDb != null && noise.noiseReductionDb > 0 ? ` · −${noise.noiseReductionDb} dB` : ''}
              </span>
            )}
          </button>
          <CameraButton />
          {status === 'connected' &&
            (screen ? (
              <IconButton label="Parar de transmitir" danger onClick={() => voice.stopScreen()}>
                <MonitorX size={16} />
              </IconButton>
            ) : (
              <IconButton label={canStream ? 'Compartilhar tela' : 'Sem permissão para transmitir neste canal'} onClick={() => canStream && setShare(true)}>
                <MonitorUp size={16} />
              </IconButton>
            ))}
          <IconButton label="Diagnóstico da chamada" onClick={() => setDiag(true)}>
            <Activity size={16} />
          </IconButton>
          <IconButton label="Desconectar" danger onClick={() => voice.leave()}>
            <PhoneOff size={16} />
          </IconButton>
        </div>
      )}
      {screen && (
        // Indicador sempre visível enquanto a tela está sendo capturada.
        <div className="voice-panel__live" role="status">
          <span className="live-dot" aria-hidden />
          <span>
            {screen.pending ? 'Iniciando transmissão…' : `Transmitindo: ${describeSurface(screen.surface)}`}
            <span className="muted"> · {viewers} assistindo</span>
          </span>
          <button className="link" onClick={() => voice.stopScreen()}>
            Parar
          </button>
        </div>
      )}
      {control && (
        // Alguém pode controlar o nosso computador: aviso fixo, com revogação a um clique.
        <div className="voice-panel__live voice-panel__live--control" role="status">
          <span className="live-dot" aria-hidden />
          <span>
            {users.get(control.guestId)?.displayName ?? 'Alguém'} pode controlar
            <span className="muted"> · Ctrl+Shift+F12</span>
          </span>
          <button className="link" onClick={() => voice.revokePlay()}>
            Revogar
          </button>
        </div>
      )}
      {requests > 0 && !control && (
        <div className="voice-panel__msg" role="status">
          <span>{requests === 1 ? 'Um pedido para jogar junto' : `${requests} pedidos para jogar junto`} — veja na sala.</span>
        </div>
      )}
      {share && <ScreenShareDialog onClose={() => setShare(false)} />}
      {diag && <VoiceDiagnostics onClose={() => setDiag(false)} />}
    </section>
  );
}
