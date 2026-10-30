import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Permission as P, type PublicUser } from '@nexo/protocol';
import { BarChart3, Eye, EyeOff, Maximize, MonitorUp, Volume2, VolumeX } from 'lucide-react';
import { Banner, Button, IconButton, Modal } from '../ui';
import { voice } from '../../voice/controller';
import {
  DEFAULT_QUALITY,
  FPS_OPTIONS,
  RESOLUTIONS,
  RESOLUTION_IDS,
  describeSurface,
  estimatedUploadKbps,
  targetKbps,
  type StreamQuality,
} from '../../voice/screen/quality';
import type { VideoRecvStats } from '../../voice/screen/stats';
import { useServers, can } from '../../stores/servers';
import { useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';
import { mediaRecvOf, remoteMediaOf, useVoice, type ViewerSendState } from '../../stores/voice';
import { GuestPlayBar, HostPlayPanel, OfferControlButton } from './PlayTogether';

const QUALITY_KEY = 'nexo.screenQuality';
const NO_VIEWERS: string[] = [];

/** Um problema na exibição de vídeo não pode derrubar o resto do app. */
class StreamBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(err: unknown) {
    console.error('[tela] falha ao exibir a transmissão', err);
  }
  override render() {
    return this.state.failed ? <Banner tone="error">Não foi possível exibir a transmissão. A chamada continua normalmente.</Banner> : this.props.children;
  }
}

/** Última qualidade usada neste computador (preferência local: depende da máquina e da rede). */
function loadQuality(): StreamQuality {
  try {
    const q = JSON.parse(localStorage.getItem(QUALITY_KEY) ?? 'null') as StreamQuality | null;
    if (q && q.resolution in RESOLUTIONS && (FPS_OPTIONS as readonly number[]).includes(q.fps) && (q.content === 'motion' || q.content === 'detail')) return q;
  } catch {
    /* sem armazenamento local */
  }
  return DEFAULT_QUALITY;
}
function saveQuality(q: StreamQuality) {
  try {
    localStorage.setItem(QUALITY_KEY, JSON.stringify(q));
  } catch {
    /* sem armazenamento local */
  }
}

const mbps = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);
const res = (w: number | null, h: number | null) => (w && h ? `${w}×${h}` : '—');
const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

/** Pode transmitir na chamada atual? Em DM sempre; em servidor, depende da permissão STREAM no canal. */
export function useCanStream(): boolean {
  const channelId = useVoice((s) => s.channelId);
  const details = useServers((s) => s.details);
  if (!channelId) return false;
  for (const d of Object.values(details)) {
    const ch = d.channels.find((c) => c.id === channelId);
    if (ch) return can(ch.myPermissions, P.STREAM);
  }
  return true; // chamada de DM
}

/** Escolha de qualidade antes de abrir o seletor do sistema (ou ajuste durante a transmissão). */
export function ScreenShareDialog({ onClose }: { onClose: () => void }) {
  const live = useVoice((s) => s.screen);
  const viewers = useVoice((s) => (s.channelId ? (s.rooms[s.channelId]?.[useSession.getState().user?.id ?? '']?.stream?.viewers.length ?? 0) : 0));
  const [q, setQ] = useState<StreamQuality>(() => live?.quality ?? loadQuality());
  const [audio, setAudio] = useState(live?.hasAudio ?? false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    saveQuality(q);
    await voice.startScreen(q, audio);
    setBusy(false);
    if (useVoice.getState().screen) onClose();
  };
  const apply = async () => {
    saveQuality(q);
    await voice.setScreenQuality(q);
    onClose();
  };

  const upload = estimatedUploadKbps(q, Math.max(1, viewers));
  return (
    <Modal
      title={live ? 'Qualidade da transmissão' : 'Compartilhar tela'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          {live ? (
            <>
              <Button variant="secondary" onClick={start} loading={busy}>
                Trocar o que compartilho
              </Button>
              <Button onClick={apply}>Aplicar</Button>
            </>
          ) : (
            <Button onClick={start} loading={busy}>
              <MonitorUp size={16} aria-hidden /> Escolher tela ou janela
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor="ss-res">
            Resolução máxima
          </label>
          <select id="ss-res" className="field__input" value={q.resolution} onChange={(e) => setQ({ ...q, resolution: e.target.value as StreamQuality['resolution'] })}>
            {RESOLUTION_IDS.map((id) => (
              <option key={id} value={id}>
                {id} ({RESOLUTIONS[id].width}×{RESOLUTIONS[id].height})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="field__label">Quadros por segundo</span>
          <div className="segmented" role="radiogroup" aria-label="Quadros por segundo">
            {FPS_OPTIONS.map((f) => (
              <button key={f} role="radio" aria-checked={q.fps === f} className={q.fps === f ? 'segmented__on' : ''} onClick={() => setQ({ ...q, fps: f })}>
                {f} FPS
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field__label">Conteúdo</span>
          <div className="segmented" role="radiogroup" aria-label="Tipo de conteúdo">
            <button role="radio" aria-checked={q.content === 'motion'} className={q.content === 'motion' ? 'segmented__on' : ''} onClick={() => setQ({ ...q, content: 'motion' })}>
              Jogo / vídeo
            </button>
            <button role="radio" aria-checked={q.content === 'detail'} className={q.content === 'detail' ? 'segmented__on' : ''} onClick={() => setQ({ ...q, content: 'detail' })}>
              Texto / código
            </button>
          </div>
          <p className="field__hint">
            {q.content === 'motion'
              ? 'Se a rede apertar, mantém a fluidez e reduz a resolução.'
              : 'Se a rede apertar, mantém a nitidez do texto e reduz os quadros por segundo.'}
          </p>
        </div>
        {!live && (
          <label className="check">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            Incluir o áudio da tela ou aba
          </label>
        )}
        {!live && audio && (
          <p className="field__hint">
            Depende do sistema: no Windows, o áudio está disponível ao compartilhar a tela inteira ou uma aba; janelas avulsas
            normalmente não têm áudio. Ao compartilhar o áudio da tela inteira, use fone de ouvido para que as vozes da chamada não
            voltem para a sala.
          </p>
        )}
        <p className="field__hint">
          Até {mbps(targetKbps(q))} por espectador. Envio estimado com {Math.max(1, viewers)} {viewers > 1 ? 'espectadores' : 'espectador'}:{' '}
          <strong>{mbps(upload)}</strong>. A qualidade real depende da fonte, da rede de cada pessoa e do processador, e aparece nas
          estatísticas durante a transmissão.
        </p>
        {upload > 15_000 && <Banner tone="warning">Isso exige uma conexão de envio rápida. Se travar, a qualidade é reduzida automaticamente.</Banner>}
        <p className="field__hint">
          O vídeo só é enviado para quem clicar em "Assistir". A escolha do que compartilhar é feita no seletor do sistema; você pode
          parar a qualquer momento.
        </p>
      </div>
    </Modal>
  );
}

/** Botão Assistir / Parar de assistir para a transmissão de alguém. */
export function WatchButton({ userId, compact }: { userId: string; compact?: boolean }) {
  const selfId = useSession((s) => s.user?.id ?? '');
  const watching = useVoice((s) => !!(s.channelId && s.rooms[s.channelId]?.[userId]?.stream?.viewers.includes(selfId)));
  const inRoom = useVoice((s) => s.status === 'connected' && !!s.channelId && !!s.rooms[s.channelId]?.[userId]);
  if (!inRoom) return null;
  return (
    <Button size={compact ? 'sm' : undefined} variant={watching ? 'secondary' : 'primary'} onClick={() => voice.watch(userId, !watching)}>
      {watching ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />} {watching ? 'Parar de assistir' : 'Assistir'}
    </Button>
  );
}

function Video({ stream, muted, volume, className }: { stream: MediaStream; muted: boolean; volume?: number; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const sink = useSettings((s) => s.settings.outputDeviceId);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    const el = ref.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el?.setSinkId && !muted) void el.setSinkId(sink === 'default' ? '' : sink).catch(() => {});
  }, [sink, muted]);
  useEffect(() => {
    if (ref.current && volume != null) ref.current.volume = Math.min(1, Math.max(0, volume));
  }, [volume]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function RecvStatsView({ s }: { s: VideoRecvStats | undefined }) {
  if (!s) return <p className="stream-stats__line">Aguardando estatísticas…</p>;
  return (
    <dl className="stream-stats">
      <dt>Recebendo</dt>
      <dd>
        {res(s.width, s.height)} · {s.fps ?? '—'} FPS
      </dd>
      <dt>Taxa</dt>
      <dd>{s.kbps != null ? mbps(s.kbps) : '—'}</dd>
      <dt>Perda</dt>
      <dd>{pct(s.loss)}</dd>
      <dt>Latência estimada</dt>
      <dd>{s.latencyMs != null ? `${s.latencyMs} ms` : '—'}</dd>
      <dt>Quadros descartados</dt>
      <dd>{s.framesDropped ?? '—'}</dd>
      <dt>Travadas</dt>
      <dd>{s.freezes ?? '—'}</dd>
      {s.decoder && (
        <>
          <dt>Decodificador</dt>
          <dd>{s.decoder}</dd>
        </>
      )}
    </dl>
  );
}

/** Transmissão de outra pessoa em destaque, com volume, tela cheia e estatísticas reais. */
function RemoteStream({ userId, user }: { userId: string; user: PublicUser | undefined }) {
  const stream = useVoice((s) => remoteMediaOf(s, userId, 'screen'));
  const st = useVoice((s) => (s.channelId ? s.rooms[s.channelId]?.[userId]?.stream : null));
  const recv = useVoice((s) => mediaRecvOf(s, userId, 'screen'));
  const deafened = useVoice((s) => s.deafened);
  const [vol, setVol] = useState(1);
  const [showStats, setShowStats] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const controlling = useVoice((s) => s.playControlling === userId);
  const hasVideo = !!stream?.getVideoTracks().some((t) => t.readyState === 'live');

  return (
    <div className="stream-stage" ref={box}>
      <div
        className={`stream-stage__video ${controlling ? 'stream-stage__video--control' : ''}`}
        ref={area}
        tabIndex={controlling ? 0 : -1}
        aria-label={controlling ? 'Controlando a transmissão: teclado e mouse vão para o anfitrião. Ctrl+Shift+F12 para soltar.' : undefined}
      >
        {controlling && <span className="control-badge">CONTROLANDO · Ctrl+Shift+F12 para soltar</span>}
        {stream && hasVideo ? (
          <Video stream={stream} muted={deafened} volume={vol} className="stream-stage__el" />
        ) : (
          <p className="stream-stage__waiting">Conectando à transmissão…</p>
        )}
        <span className="live-badge">AO VIVO</span>
        {showStats && (
          <div className="stream-stage__stats">
            <RecvStatsView s={recv} />
          </div>
        )}
      </div>
      <div className="stream-stage__bar">
        <span className="stream-stage__who">
          <strong>{user?.displayName ?? 'Participante'}</strong>
          <span className="muted"> · {describeSurface(st?.surface ?? 'unknown')}</span>
        </span>
        {st?.hasAudio && (
          <label className="stream-stage__vol">
            {deafened || vol === 0 ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}
            <span className="sr-only">Volume da transmissão</span>
            <input type="range" min={0} max={1} step={0.05} value={vol} disabled={deafened} onChange={(e) => setVol(Number(e.target.value))} />
          </label>
        )}
        <IconButton label={showStats ? 'Ocultar estatísticas' : 'Mostrar estatísticas'} onClick={() => setShowStats(!showStats)}>
          <BarChart3 size={16} />
        </IconButton>
        <IconButton label="Tela cheia" onClick={() => void box.current?.requestFullscreen?.().catch(() => {})}>
          <Maximize size={16} />
        </IconButton>
        <GuestPlayBar hostId={userId} control={st?.control ?? null} area={area} />
        <WatchButton userId={userId} compact />
      </div>
    </div>
  );
}

function SendStatsRow({ name, s, wanted, children }: { name: string; s: ViewerSendState; wanted: StreamQuality; children?: ReactNode }) {
  return (
    <li className="send-stats">
      <div className="send-stats__head">
        <strong>{name}</strong>
        {children}
        <span className="mono">
          {res(s.width, s.height)} · {s.fps ?? '—'} FPS · {s.kbps != null ? mbps(s.kbps) : '—'}
        </span>
      </div>
      <span className="muted">
        Escolhido: {wanted.resolution} {wanted.fps} FPS · perda {pct(s.loss)} · RTT {s.rttMs ?? '—'} ms
        {s.encoder ? ` · ${s.encoder}` : ''}
      </span>
      {s.reasons.map((r) => (
        <span key={r} className="send-stats__why">
          {r}
        </span>
      ))}
    </li>
  );
}

/** Nossa transmissão: prévia, quem assiste e o que cada pessoa está recebendo de fato. */
function LocalStream({ users }: { users: Map<string, PublicUser> }) {
  const screen = useVoice((s) => s.screen);
  const send = useVoice((s) => s.screenSend);
  const selfId = useSession((s) => s.user?.id ?? '');
  // Constante (não um [] novo): o seletor precisa devolver o mesmo valor quando nada mudou.
  const viewers = useVoice((s) => (s.channelId ? s.rooms[s.channelId]?.[selfId]?.stream?.viewers : undefined)) ?? NO_VIEWERS;
  const [dialog, setDialog] = useState(false);
  const control = useVoice((s) => (s.channelId ? s.rooms[s.channelId]?.[selfId]?.stream?.control : null)) ?? null;
  if (!screen) return null;
  return (
    <div className="stream-stage stream-stage--self">
      <div className="stream-stage__video">
        {/* Prévia local sem áudio: ouvir a própria captura causaria eco. */}
        <Video stream={screen.preview} muted className="stream-stage__el" />
        <span className="live-badge">{screen.pending ? 'INICIANDO…' : 'AO VIVO'}</span>
      </div>
      <div className="stream-stage__bar">
        <span className="stream-stage__who">
          <strong>Você está transmitindo</strong>
          <span className="muted">
            {' '}
            · {describeSurface(screen.surface)}
            {screen.hasAudio ? ' com áudio' : ''} · {viewers.length} {viewers.length === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}
          </span>
        </span>
        <Button size="sm" variant="secondary" onClick={() => setDialog(true)}>
          Qualidade
        </Button>
        <Button size="sm" variant="danger" onClick={() => voice.stopScreen()}>
          Parar de transmitir
        </Button>
      </div>
      <HostPlayPanel users={users} control={control} />
      {screen.audioUnavailable && <Banner tone="info">O sistema não forneceu áudio para essa fonte; a transmissão segue só com imagem.</Banner>}
      {viewers.length > 0 ? (
        <ul className="send-stats-list" aria-label="O que cada espectador está recebendo">
          {viewers.map((id) =>
            send[id] ? (
              <SendStatsRow key={id} name={users.get(id)?.displayName ?? 'Espectador'} s={send[id]!} wanted={screen.quality}>
                {control?.guestId !== id && <OfferControlButton guestId={id} guest={users.get(id)} />}
              </SendStatsRow>
            ) : (
              <li key={id} className="send-stats">
                <strong>{users.get(id)?.displayName ?? 'Espectador'}</strong> <span className="muted">conectando…</span>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="field__hint">Ninguém está assistindo: nenhum vídeo está sendo enviado agora.</p>
      )}
      {dialog && <ScreenShareDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

/** Área de transmissões da sala: a nossa (se houver) e a que estamos assistindo. */
export function StreamStage(props: { channelId: string; users: Map<string, PublicUser> }) {
  return (
    <StreamBoundary>
      <Streams {...props} />
    </StreamBoundary>
  );
}

function Streams({ channelId, users }: { channelId: string; users: Map<string, PublicUser> }) {
  const mine = useVoice((s) => s.channelId === channelId && s.status === 'connected');
  const selfId = useSession((s) => s.user?.id ?? '');
  const room = useVoice((s) => s.rooms[channelId]);
  const watched = Object.values(room ?? {}).filter((p) => p.userId !== selfId && p.stream?.viewers.includes(selfId));
  const hasLocal = useVoice((s) => !!s.screen);
  if (!mine || (!hasLocal && watched.length === 0)) return null;
  return (
    <section className="streams" aria-label="Transmissões">
      {watched.map((p) => (
        <RemoteStream key={p.userId} userId={p.userId} user={users.get(p.userId)} />
      ))}
      <LocalStream users={users} />
    </section>
  );
}
