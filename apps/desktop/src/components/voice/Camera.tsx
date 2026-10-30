import { useCallback, useEffect, useRef, useState } from 'react';
import { Permission as P } from '@nexo/protocol';
import { Camera as CameraIcon, Square, Video, VideoOff } from 'lucide-react';
import { Banner, Button, IconButton, Toggle } from '../ui';
import { voice } from '../../voice/controller';
import { CAMERA_QUALITIES, cameraConstraints, cameraErrorMessage, loadCameraPrefs, saveCameraPrefs, type CameraPrefs, type CameraQuality } from '../../voice/camera';
import { can, useServers } from '../../stores/servers';
import { remoteMediaOf, useVoice } from '../../stores/voice';

/** Pode ligar a câmera na chamada atual? Em DM sempre; em servidor, depende da permissão VIDEO. */
export function useCanVideo(): boolean {
  const channelId = useVoice((s) => s.channelId);
  const details = useServers((s) => s.details);
  if (!channelId) return false;
  for (const d of Object.values(details)) {
    const ch = d.channels.find((c) => c.id === channelId);
    if (ch) return can(ch.myPermissions, P.VIDEO);
  }
  return true;
}

/** Liga/desliga a câmera. O estado aparece no próprio botão (e o sistema acende a luz da câmera). */
export function CameraButton() {
  const on = useVoice((s) => !!s.camera);
  const connected = useVoice((s) => s.status === 'connected');
  const allowed = useCanVideo();
  if (!connected) return null;
  const label = on ? 'Desligar câmera' : allowed ? 'Ligar câmera' : 'Sem permissão para usar a câmera neste canal';
  return (
    <IconButton label={label} className={on ? 'icon-btn--on' : undefined} onClick={() => (on || allowed) && voice.toggleCamera()}>
      {on ? <Video size={16} /> : <VideoOff size={16} />}
    </IconButton>
  );
}

function VideoEl({ stream, mirror, className }: { stream: MediaStream; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  // Câmera nunca toca áudio: o som da pessoa vem pela voz.
  return <video ref={ref} className={`${className ?? ''} ${mirror ? 'video--mirror' : ''}`} autoPlay playsInline muted />;
}

/**
 * Vídeo da câmera dentro do quadro do participante. Para nós mesmos, a prévia local (espelhada se a
 * pessoa preferir — só na nossa tela); para os outros, o que chega pela conexão.
 */
export function TileCamera({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const local = useVoice((s) => (isSelf ? s.camera?.preview : undefined));
  const remote = useVoice((s) => (isSelf ? undefined : remoteMediaOf(s, userId, 'camera')));
  const [mirror] = useState(() => loadCameraPrefs().mirror);
  const stream = local ?? remote;
  const live = !!stream?.getVideoTracks().some((t) => t.readyState === 'live');
  if (!stream || !live) return <span className="tile-camera tile-camera--waiting">Conectando câmera…</span>;
  return <VideoEl stream={stream} mirror={isSelf && mirror} className="tile-camera" />;
}

/** Configurações → Voz e vídeo → Câmera: dispositivo, qualidade, espelho e teste com prévia local. */
export function CameraSettings() {
  const [prefs, setPrefs] = useState<CameraPrefs>(loadCameraPrefs);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inCall = useVoice((s) => !!s.camera);

  const refresh = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((all) => setDevices(all.filter((d) => d.kind === 'videoinput')))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);
  // Fechar a tela de configurações sempre libera a câmera do teste.
  useEffect(() => () => preview?.getTracks().forEach((t) => t.stop()), [preview]);

  const update = (p: Partial<CameraPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveCameraPrefs(next);
    if (preview && (p.deviceId || p.quality)) void startTest(next);
  };

  const startTest = async (p = prefs) => {
    setError(null);
    preview?.getTracks().forEach((t) => t.stop());
    try {
      const s = await navigator.mediaDevices.getUserMedia(cameraConstraints(p.quality, p.deviceId));
      setPreview(s);
      refresh(); // com a permissão concedida, os nomes das câmeras aparecem
    } catch (err) {
      setPreview(null);
      setError(cameraErrorMessage(err));
    }
  };
  const stopTest = () => {
    preview?.getTracks().forEach((t) => t.stop());
    setPreview(null);
  };

  const settings = preview?.getVideoTracks()[0]?.getSettings();
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);

  return (
    <section className="panel" aria-labelledby="cam-h">
      <h2 id="cam-h" className="panel__title">
        Câmera
      </h2>
      <p className="muted">
        A câmera só liga quando você clica no botão de câmera numa chamada, e vai para as pessoas da sala. A escolha de
        dispositivo fica só neste computador.
      </p>
      {unnamed && <Banner tone="info">Os nomes das câmeras aparecem depois que você permite o acesso (por exemplo, no teste abaixo).</Banner>}
      <div className="field">
        <label className="field__label" htmlFor="cam-dev">
          Dispositivo
        </label>
        <select id="cam-dev" className="field__input" value={prefs.deviceId} onChange={(e) => update({ deviceId: e.target.value })}>
          <option value="default">Padrão do sistema</option>
          {devices
            .filter((d) => d.deviceId && d.deviceId !== 'default')
            .map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Câmera ${i + 1}`}
              </option>
            ))}
        </select>
        {devices.length === 0 && <p className="field__hint">Nenhuma câmera detectada.</p>}
      </div>
      <div className="field">
        <span className="field__label">Qualidade</span>
        <div className="segmented" role="radiogroup" aria-label="Qualidade da câmera">
          {(Object.keys(CAMERA_QUALITIES) as CameraQuality[]).map((q) => (
            <button key={q} role="radio" aria-checked={prefs.quality === q} className={prefs.quality === q ? 'segmented__on' : ''} onClick={() => update({ quality: q })}>
              {CAMERA_QUALITIES[q].label}
            </button>
          ))}
        </div>
        <p className="field__hint">
          Até {CAMERA_QUALITIES[prefs.quality].kbps} kbps por pessoa na sala (cada pessoa recebe uma cópia). Vale a partir da
          próxima vez que você ligar a câmera.
        </p>
      </div>
      <Toggle label="Espelhar minha prévia" description="Só muda como você se vê; os outros recebem a imagem normal." checked={prefs.mirror} onChange={(v) => update({ mirror: v })} />
      <div className="camera-test">
        {preview ? (
          <>
            <VideoEl stream={preview} mirror={prefs.mirror} className="camera-test__video" />
            <p className="field__hint mono">
              {settings?.width && settings.height ? `${settings.width}×${settings.height}` : '—'}
              {settings?.frameRate ? ` · ${Math.round(settings.frameRate)} FPS` : ''} (o que a câmera está entregando)
            </p>
            <Button variant="secondary" onClick={stopTest}>
              <Square size={16} aria-hidden /> Parar teste
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => void startTest()} disabled={inCall}>
            <CameraIcon size={16} aria-hidden /> Testar câmera
          </Button>
        )}
        {inCall && !preview && <p className="field__hint">Sua câmera está ligada numa chamada; o teste fica disponível depois que você desligá-la.</p>}
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </section>
  );
}
