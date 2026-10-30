import { useEffect, useRef, useState } from 'react';
import type { UserSettings } from '@nexo/protocol';
import { Circle, Play, Square } from 'lucide-react';
import { Banner, Button } from '../../components/ui';
import { MicError, MicPipeline, micOptionsFrom, setContextSink } from '../../voice/MicPipeline';
import { measureNeuralCostUs } from '../../voice/dsp/noiseNode';
import { processOffline, type OfflineResult } from '../../voice/dsp/offline';
import type { NoiseMode } from '../../voice/dsp/suppressor';
import { useSettings } from '../../stores/settings';
import { useVoice } from '../../stores/voice';

export const NOISE_MODES: Array<{ id: NoiseMode; label: string; desc: string }> = [
  { id: 'auto', label: 'Automático', desc: 'Mede o ruído do ambiente e ajusta a força sozinho: quase nada num quarto silencioso, mais num lugar barulhento.' },
  { id: 'strong', label: 'Forte', desc: 'Prioriza silêncio: rede neural completa e corte do resíduo entre as palavras. Pode cortar o fim de palavras baixas.' },
  { id: 'balanced', label: 'Equilibrado', desc: 'Rede neural completa, sem o corte entre palavras. Boa remoção com voz preservada.' },
  { id: 'light', label: 'Leve', desc: 'Reduz o ruído até cerca de 18 dB: menos artefatos, um pouco do ambiente permanece.' },
  { id: 'natural', label: 'Natural', desc: 'Redução de até cerca de 10 dB: a voz mais natural possível, para ambientes já silenciosos.' },
  { id: 'economy', label: 'Economia', desc: 'Só a supressão clássica do WebRTC, quase sem custo de CPU. Para computadores modestos.' },
  { id: 'off', label: 'Desativado', desc: 'Nenhuma supressão adicional. Cancelamento de eco e ganho automático seguem suas opções.' },
];

const LABEL = Object.fromEntries(NOISE_MODES.map((m) => [m.id, m.label])) as Record<string, string>;
const APPLIED: Record<string, string> = { ...LABEL, economy: 'Economia', off: 'Desativado', loading: 'carregando…' };

export function NoiseSection() {
  const mode = useSettings((s) => s.settings.noiseMode);
  const update = useSettings((s) => s.update);
  const live = useVoice((s) => s.noise);
  const [cost, setCost] = useState<number | null>(null);

  useEffect(() => {
    measureNeuralCostUs().then(setCost, () => setCost(null));
  }, []);

  return (
    <section className="panel" aria-labelledby="noise-h">
      <h2 id="noise-h" className="panel__title">Supressão de ruído</h2>
      <p className="muted">
        Roda inteiramente no seu computador (RNNoise, rede neural local). Nenhum áudio é enviado a serviços externos.
      </p>
      <div className="radio-cards noise-modes" role="radiogroup" aria-label="Modo de supressão de ruído">
        {NOISE_MODES.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={mode === m.id}
            className={`radio-card ${mode === m.id ? 'radio-card--on' : ''}`}
            onClick={() => update({ noiseMode: m.id as UserSettings['noiseMode'] })}
          >
            <span>
              <strong>{m.label}</strong>
              <span className="muted">{m.desc}</span>
            </span>
          </button>
        ))}
      </div>
      {live && (
        <p className="noise-live" role="status">
          Na chamada agora: <strong>{APPLIED[live.applied]}</strong>
          {live.mode === 'auto' && live.applied !== 'loading' && ' (escolha do Automático)'}
          {live.noiseReductionDb != null && ` · ruído reduzido em ${live.noiseReductionDb} dB`}
          {live.snrDb != null && ` · relação fala/ruído ~${live.snrDb} dB`}
          {live.loadPct != null && ` · carga de áudio ${live.loadPct}%`}
        </p>
      )}
      {live?.fallback && <Banner tone="warning">O modo Economia foi ativado automaticamente nesta sessão para não prejudicar a chamada. Escolher outro modo tenta de novo.</Banner>}
      <p className="field__hint">
        {cost != null
          ? `Custo medido neste computador: ${(cost / 1000).toFixed(2)} ms por 10 ms de áudio (≈${Math.max(1, Math.round(cost / 100))}% de um núcleo). Latência adicionada nos modos neurais: 20 ms.`
          : 'Medindo o custo neste computador…'}
      </p>
      <details className="noise-limits">
        <summary>O que a supressão remove bem — e o que não remove</summary>
        <ul>
          <li><strong>Bem:</strong> ventoinha, ar-condicionado, chiado, ruído elétrico e trânsito constante.</li>
          <li><strong>Parcialmente:</strong> teclado mecânico, cliques de mouse e latidos (sons curtos e fortes) — o modo Forte ajuda entre as palavras.</li>
          <li><strong>Não remove:</strong> conversas, TV e jogos com vozes ao fundo — para a rede, também é fala.</li>
          <li><strong>Eco dos alto-falantes:</strong> tratado pelo cancelamento de eco, não pela rede neural. Fone de ouvido resolve de vez.</li>
          <li><strong>Reverberação</strong> (sala vazia) não é removida.</li>
        </ul>
      </details>
      <AbCompare />
    </section>
  );
}

const RECORD_SECONDS = 6;
const AB_MODES: NoiseMode[] = ['off', 'natural', 'light', 'balanced', 'strong', 'auto'];

/**
 * Comparação A/B com a sua voz: grava alguns segundos do microfone (como capturado, antes do
 * processamento do app) e mostra a mesma gravação em cada modo. Fica só na memória desta tela.
 */
function AbCompare() {
  const settings = useSettings((s) => s.settings);
  const inCall = useVoice((s) => !!s.channelId);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'processing' | 'ready'>('idle');
  const [left, setLeft] = useState(RECORD_SECONDS);
  const [results, setResults] = useState<OfflineResult[] | null>(null);
  const [playing, setPlaying] = useState<NoiseMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playCtx = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);

  useEffect(
    () => () => {
      source.current?.stop();
      void playCtx.current?.close();
    },
    [],
  );

  const record = async () => {
    setError(null);
    setResults(null);
    const ctx = new AudioContext({ sampleRate: 48_000 });
    let mic: MicPipeline | null = null;
    try {
      // Mesma captura da chamada (eco e ganho automático conforme suas opções), sem supressão.
      mic = await MicPipeline.open(ctx, micOptionsFrom({ ...settings, noiseMode: 'off' }));
      const rec = await captureSamples(ctx, mic.rawStream, RECORD_SECONDS, (s) => {
        setPhase('recording');
        setLeft(s);
      });
      setPhase('processing');
      setResults(await processOffline(rec, AB_MODES));
      setPhase('ready');
    } catch (e) {
      setError(e instanceof MicError ? e.message : 'Não foi possível gravar.');
      setPhase('idle');
    } finally {
      mic?.stop();
      void ctx.close();
    }
  };

  const play = async (r: OfflineResult) => {
    source.current?.stop();
    if (playing === r.mode) return setPlaying(null);
    playCtx.current ??= new AudioContext({ sampleRate: 48_000 });
    const ctx = playCtx.current;
    await setContextSink(ctx, settings.outputDeviceId);
    const buf = ctx.createBuffer(1, r.audio.length, 48_000);
    buf.copyToChannel(r.audio as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => setPlaying((p) => (p === r.mode ? null : p));
    src.start();
    source.current = src;
    setPlaying(r.mode);
  };

  return (
    <div className="ab">
      <h3 className="panel__title">Comparar original × processado</h3>
      <p className="muted">
        Grave {RECORD_SECONDS} segundos falando normalmente, com o ruído do seu ambiente (digite no teclado, ligue a ventoinha…).
        Depois ouça a mesma gravação em cada modo. A gravação fica só nesta tela e é descartada ao sair.
      </p>
      <div className="row">
        <Button variant="secondary" onClick={() => void record()} disabled={phase === 'recording' || phase === 'processing' || inCall} loading={phase === 'processing'}>
          {phase === 'recording' ? <><Circle size={12} className="rec-dot" aria-hidden /> Gravando… {left}s</> : <><Circle size={12} aria-hidden /> {results ? 'Gravar de novo' : 'Gravar amostra'}</>}
        </Button>
        {inCall && <span className="field__hint">Saia da chamada para gravar uma amostra.</span>}
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {results && (
        <ul className="ab__list">
          {results.map((r) => (
            <li key={r.mode} className={`ab__row ${playing === r.mode ? 'ab__row--on' : ''}`}>
              <Button size="sm" variant={playing === r.mode ? 'primary' : 'secondary'} onClick={() => void play(r)} aria-label={`${playing === r.mode ? 'Parar' : 'Ouvir'} ${r.mode === 'off' ? 'original' : LABEL[r.mode]}`}>
                {playing === r.mode ? <Square size={12} aria-hidden /> : <Play size={12} aria-hidden />}
              </Button>
              <strong>{r.mode === 'off' ? 'Original' : LABEL[r.mode]}</strong>
              <span className="muted">
                {r.stats
                  ? `ruído −${r.stats.noiseReductionDb} dB · fala −${r.stats.speechLossDb} dB${r.mode === 'auto' ? ` · escolheu ${LABEL[r.stats.applied] ?? r.stats.applied}` : ''}`
                  : 'sem processamento'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="field__hint">O modo Economia age na captura do microfone e por isso não entra nesta comparação.</p>
    </div>
  );
}

/** Captura amostras PCM cruas (sem compressão) de uma stream por alguns segundos. */
function captureSamples(ctx: AudioContext, stream: MediaStream, seconds: number, onTick: (secondsLeft: number) => void): Promise<Float32Array> {
  return new Promise((resolve) => {
    const src = ctx.createMediaStreamSource(stream);
    // ScriptProcessor é obsoleto, mas serve bem para capturar uma amostra curta sem dependências.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const total = seconds * ctx.sampleRate;
    const out = new Float32Array(total);
    let n = 0;
    onTick(seconds);
    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      const take = Math.min(data.length, total - n);
      out.set(data.subarray(0, take), n);
      n += take;
      onTick(Math.ceil((total - n) / ctx.sampleRate));
      if (n >= total) {
        proc.disconnect();
        src.disconnect();
        resolve(out);
      }
    };
    src.connect(proc);
    proc.connect(ctx.destination); // o ScriptProcessor só roda conectado; a saída é silêncio
  });
}
