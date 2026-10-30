import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, type UserSettings } from '@nexo/protocol';
import { Mic, Square } from 'lucide-react';
import { Banner, Button, Toggle } from '../../components/ui';
import { MicError, MicPipeline, listDevices, micOptionsFrom, setContextSink } from '../../voice/MicPipeline';
import { useSettings } from '../../stores/settings';
import { useVoice } from '../../stores/voice';
import { NoiseNode, type NoiseStats } from '../../voice/dsp/noiseNode';
import { usesNeural } from '../../voice/dsp/suppressor';
import { NoiseSection } from './NoiseSection';
import { CameraSettings } from '../../components/voice/Camera';

function useSetting<K extends keyof UserSettings>(key: K): [UserSettings[K], (v: UserSettings[K]) => void] {
  const value = useSettings((s) => s.settings[key]);
  const update = useSettings((s) => s.update);
  return [value, (v) => update({ [key]: v } as Partial<UserSettings>)];
}

const VOICE_KEYS: Array<keyof UserSettings> = [
  'inputDeviceId',
  'outputDeviceId',
  'inputVolume',
  'outputVolume',
  'inputMode',
  'vadThresholdDb',
  'pushToTalkKey',
  'echoCancellation',
  'autoGainControl',
  'noiseMode',
  'voiceRelayOnly',
];

const keyLabel = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '').replace('Backquote', "' (acento grave)");

export function VoiceSection() {
  const [inputId, setInputId] = useSetting('inputDeviceId');
  const [outputId, setOutputId] = useSetting('outputDeviceId');
  const [inVol, setInVol] = useSetting('inputVolume');
  const [outVol, setOutVol] = useSetting('outputVolume');
  const [mode, setMode] = useSetting('inputMode');
  const [threshold, setThreshold] = useSetting('vadThresholdDb');
  const [pttKey, setPttKey] = useSetting('pushToTalkKey');
  const [aec, setAec] = useSetting('echoCancellation');
  const [agc, setAgc] = useSetting('autoGainControl');
  const [relay, setRelay] = useSetting('voiceRelayOnly');
  const relayAvailable = useVoice((s) => s.relayAvailable);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>({ inputs: [], outputs: [] });
  const [capturing, setCapturing] = useState(false);

  const refresh = useCallback(() => {
    listDevices().then(setDevices, () => {});
  }, []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  // Sem permissão concedida, o sistema esconde os nomes dos dispositivos.
  const unnamed = devices.inputs.length > 0 && devices.inputs.every((d) => !d.label);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code !== 'Escape') setPttKey(e.code);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { once: true, capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, setPttKey]);

  const reset = () => useSettings.getState().update(Object.fromEntries(VOICE_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<UserSettings>);

  return (
    <div className="stack-lg">
      <section className="panel">
        <h2 className="panel__title">Dispositivos</h2>
        {unnamed && (
          <Banner tone="info">
            Os nomes dos dispositivos aparecem depois que você permite o acesso ao microfone (por exemplo, no teste abaixo).
          </Banner>
        )}
        <div className="grid-2">
          <div className="field">
            <label className="field__label" htmlFor="in-dev">Dispositivo de entrada</label>
            <select id="in-dev" className="field__input" value={inputId} onChange={(e) => setInputId(e.target.value)}>
              <option value="default">Padrão do sistema</option>
              {devices.inputs
                .filter((d) => d.deviceId && d.deviceId !== 'default')
                .map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microfone ${i + 1}`}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="out-dev">Dispositivo de saída</label>
            <select id="out-dev" className="field__input" value={outputId} onChange={(e) => setOutputId(e.target.value)}>
              <option value="default">Padrão do sistema</option>
              {devices.outputs
                .filter((d) => d.deviceId && d.deviceId !== 'default')
                .map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Saída ${i + 1}`}</option>)}
            </select>
          </div>
        </div>
        <div className="grid-2">
          <VolumeSlider label="Volume de entrada" value={inVol} onChange={setInVol} />
          <VolumeSlider label="Volume de saída" value={outVol} onChange={setOutVol} />
        </div>
        <p className="field__hint">Se um headset for desconectado durante a chamada, o VYRON passa para o dispositivo padrão e avisa.</p>
      </section>

      <section className="panel">
        <h2 className="panel__title">Modo de entrada</h2>
        <div className="segmented" role="radiogroup" aria-label="Modo de entrada">
          <button role="radio" aria-checked={mode === 'voice_activity'} className={mode === 'voice_activity' ? 'segmented__on' : ''} onClick={() => setMode('voice_activity')}>
            Ativação por voz
          </button>
          <button role="radio" aria-checked={mode === 'push_to_talk'} className={mode === 'push_to_talk' ? 'segmented__on' : ''} onClick={() => setMode('push_to_talk')}>
            Pressionar para falar
          </button>
        </div>
        {mode === 'push_to_talk' ? (
          <div className="row">
            <span>Tecla:</span>
            <Button variant="secondary" onClick={() => setCapturing(true)} aria-live="polite">
              {capturing ? 'Pressione uma tecla… (Esc cancela)' : <kbd>{keyLabel(pttKey)}</kbd>}
            </Button>
            <span className="field__hint">Funciona com o VYRON em foco e fora de campos de texto. Atalho global do Windows chega com o app nativo.</span>
          </div>
        ) : (
          <p className="field__hint">O microfone abre quando o nível passa do limiar abaixo e fecha 0,4 s depois do silêncio, sem cortar o fim das palavras.</p>
        )}
        <MicTester threshold={threshold} onThreshold={setThreshold} showThreshold={mode === 'voice_activity'} />
      </section>

      <section className="panel">
        <h2 className="panel__title">Processamento de áudio</h2>
        <Toggle label="Cancelamento de eco" description="Evita que o som dos seus alto-falantes volte para a chamada. Desative só se usar fone." checked={aec} onChange={setAec} />
        <Toggle label="Controle automático de ganho" description="Equilibra seu volume quando você se afasta ou se aproxima do microfone." checked={agc} onChange={setAgc} />
        <p className="field__hint">
          Ordem da cadeia: cancelamento de eco e ganho automático (na captura) → supressão de ruído → volume de entrada →
          limitador de picos → ativação por voz → Opus. Alterações valem na hora, inclusive durante uma chamada.
        </p>
      </section>

      <NoiseSection />

      <CameraSettings />

      <section className="panel">
        <h2 className="panel__title">Privacidade nas chamadas</h2>
        <Toggle
          label="Ocultar meu IP (usar apenas retransmissão)"
          description="Chamadas são diretas entre os participantes, o que expõe o endereço IP a eles. Com esta opção o áudio passa por um servidor TURN e ninguém vê seu IP — com um pouco mais de latência."
          checked={relay}
          onChange={setRelay}
        />
        {relay && !relayAvailable && (
          <Banner tone="warning">Este servidor ainda não informou um TURN. Se ele não tiver um, a entrada em salas de voz será recusada com esta opção ativa.</Banner>
        )}
      </section>

      <div>
        <Button variant="ghost" onClick={reset}>Restaurar configurações de voz</Button>
      </div>
    </div>
  );
}

function VolumeSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="slider-row">
        <input type="range" min={0} max={2} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} aria-valuetext={`${Math.round(value * 100)}%`} />
        <span className="mono">{Math.round(value * 100)}%</span>
      </div>
    </div>
  );
}

/**
 * Teste de microfone: abre a captura só enquanto o teste está ligado (com indicação visível),
 * mostra o nível ao vivo e, opcionalmente, devolve a própria voz no fone.
 */
function MicTester({ threshold, onThreshold, showThreshold }: { threshold: number; onThreshold: (v: number) => void; showThreshold: boolean }) {
  const settings = useSettings((s) => s.settings);
  const [running, setRunning] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [level, setLevel] = useState(-100);
  const [error, setError] = useState<string | null>(null);
  const [noiseStats, setNoiseStats] = useState<NoiseStats | null>(null);
  const refs = useRef<{ ctx: AudioContext; mic: MicPipeline; noise?: NoiseNode; unmonitor?: () => void; timer: ReturnType<typeof setInterval> } | null>(null);
  const inCall = useVoice((s) => !!s.channelId);

  const stop = useCallback(() => {
    const r = refs.current;
    refs.current = null;
    if (!r) return;
    clearInterval(r.timer);
    r.unmonitor?.();
    r.noise?.destroy();
    r.mic.stop();
    void r.ctx.close();
    setRunning(false);
    setLevel(-100);
    setNoiseStats(null);
  }, []);

  const start = async () => {
    setError(null);
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 });
      const mic = await MicPipeline.open(ctx, micOptionsFrom(settings));
      await setContextSink(ctx, settings.outputDeviceId);
      const timer = setInterval(() => setLevel(mic.level()), 50);
      refs.current = { ctx, mic, timer };
      setRunning(true);
      // A mesma supressão da chamada: o medidor e o "ouvir minha voz" mostram o resultado processado.
      if (usesNeural(settings.noiseMode)) {
        NoiseNode.create(ctx, settings.noiseMode).then(
          (noise) => {
            if (refs.current?.mic !== mic) return noise.destroy();
            refs.current.noise = noise;
            noise.onStats(setNoiseStats);
            mic.setNoiseNode(noise.node);
          },
          () => setError('A supressão neural não carregou; o teste segue sem ela.'),
        );
      }
    } catch (e) {
      setError(e instanceof MicError ? e.message : 'Não foi possível abrir o microfone.');
    }
  };

  // Reabre com as novas opções se o dispositivo/processamento mudar durante o teste.
  const key = `${settings.inputDeviceId}|${settings.echoCancellation}|${settings.noiseMode}|${settings.autoGainControl}`;
  const firstKey = useRef(key);
  useEffect(() => {
    if (key === firstKey.current) return;
    firstKey.current = key;
    if (refs.current) {
      stop();
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    refs.current?.mic.setVolume(settings.inputVolume);
  }, [settings.inputVolume]);

  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    r.unmonitor?.();
    r.unmonitor = monitor ? r.mic.connectMonitor(r.ctx.destination) : undefined;
  }, [monitor, running]);

  useEffect(() => stop, [stop]);

  // Barra de 0 a 100 mapeando -100 dBFS → 0 dBFS.
  const pct = (db: number) => Math.max(0, Math.min(100, db + 100));
  const open = level >= threshold;

  return (
    <div className="mic-test">
      <div className="mic-test__head">
        <Button variant={running ? 'danger' : 'secondary'} onClick={() => (running ? stop() : void start())} disabled={inCall && !running}>
          {running ? <><Square size={14} aria-hidden /> Parar teste</> : <><Mic size={14} aria-hidden /> Testar microfone</>}
        </Button>
        {running && (
          <label className="check">
            <input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />
            Ouvir minha voz (use fone para evitar microfonia)
          </label>
        )}
        {running && <span className="mic-test__live" role="status"><span className="dot dot--down" /> Microfone ativo</span>}
      </div>
      {inCall && !running && <p className="field__hint">Saia da chamada para testar o microfone aqui.</p>}
      {running && noiseStats && (
        <p className="field__hint" role="status">
          Supressão: ruído de fundo {noiseStats.noiseFloorDb} dBFS, reduzido em {noiseStats.noiseReductionDb} dB
          {noiseStats.snrDb != null && ` · fala/ruído ~${noiseStats.snrDb} dB`}
        </p>
      )}
      <div className={`meter ${running ? '' : 'meter--idle'}`} aria-hidden>
        <div className={`meter__fill ${open || !showThreshold ? 'meter__fill--open' : ''}`} style={{ width: `${pct(level)}%` }} />
        {showThreshold && <div className="meter__threshold" style={{ left: `${pct(threshold)}%` }} />}
      </div>
      {showThreshold && (
        <div className="field">
          <label className="field__label" htmlFor="vad">
            Sensibilidade (limiar: {threshold} dB) {running && <span className={open ? 'tag' : 'muted'}>{open ? 'transmitindo' : 'em silêncio'}</span>}
          </label>
          <input id="vad" type="range" min={-100} max={-10} step={1} value={threshold} onChange={(e) => onThreshold(Number(e.target.value))} />
          <p className="field__hint">Fale normalmente: a barra deve passar da marca quando você fala e ficar abaixo dela no silêncio do ambiente.</p>
        </div>
      )}
      {error && <Banner tone="error">{error}</Banner>}
    </div>
  );
}
