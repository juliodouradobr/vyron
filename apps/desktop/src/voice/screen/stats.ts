/**
 * Estatísticas reais de vídeo, lidas do getStats() do WebRTC.
 * Funções puras sobre a lista de registros: testáveis sem navegador.
 */

type Rec = Record<string, unknown> & { type: string; id: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type Limitation = 'none' | 'bandwidth' | 'cpu' | 'other';

/** Do lado de quem transmite, por espectador. */
export interface VideoSendStats {
  /** Resolução e FPS que saem do codificador agora (a qualidade "negociada" de fato). */
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Resolução/FPS da captura (antes do codificador). */
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceFps: number | null;
  kbps: number | null;
  /** Fração perdida informada pelo espectador (RTCP), 0–1. */
  loss: number | null;
  rttMs: number | null;
  /** O próprio codificador diz por que está abaixo do pedido. */
  limitation: Limitation;
  encoder: string | null;
}

/** Do lado de quem assiste. */
export interface VideoRecvStats {
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
  /** Fração de pacotes perdidos desde a última coleta, 0–1. */
  loss: number | null;
  /** Atraso do buffer de recepção (ms). */
  jitterBufferMs: number | null;
  rttMs: number | null;
  /** Estimativa de atraso ponta a ponta: metade do RTT + buffer de recepção. Não inclui captura/codificação. */
  latencyMs: number | null;
  framesDropped: number | null;
  freezes: number | null;
  decoder: string | null;
}

export interface Counters {
  at: number;
  bytes: number;
  lost: number;
  received: number;
  /** Acumulados do buffer de recepção (para medir o atraso do intervalo, não a média desde o início). */
  jbDelay: number;
  jbEmitted: number;
}

function rtt(list: Rec[]): number | null {
  const pair = list.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
  const v = num(pair?.currentRoundTripTime);
  return v == null ? null : Math.round(v * 1000);
}

const kbpsFrom = (bytes: number, prev: Counters | null, now: number) =>
  prev && now > prev.at ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / ((now - prev.at) / 1000) / 1000)) : null;

export function summarizeSend(list: Rec[], prev: Counters | null, now: number): { stats: VideoSendStats; counters: Counters } | null {
  const out = list.find((r) => r.type === 'outbound-rtp' && r.kind === 'video');
  if (!out) return null;
  const src = list.find((r) => r.id === out.mediaSourceId) ?? list.find((r) => r.type === 'media-source' && r.kind === 'video');
  const remote = list.find((r) => r.type === 'remote-inbound-rtp' && r.kind === 'video');
  const bytes = num(out.bytesSent) ?? 0;
  const reason = out.qualityLimitationReason;
  const remoteRtt = num(remote?.roundTripTime);
  return {
    stats: {
      width: num(out.frameWidth),
      height: num(out.frameHeight),
      fps: num(out.framesPerSecond),
      sourceWidth: num(src?.width),
      sourceHeight: num(src?.height),
      sourceFps: num(src?.framesPerSecond),
      kbps: kbpsFrom(bytes, prev, now),
      loss: num(remote?.fractionLost),
      rttMs: remoteRtt != null ? Math.round(remoteRtt * 1000) : rtt(list),
      limitation: reason === 'bandwidth' || reason === 'cpu' || reason === 'other' ? reason : 'none',
      encoder: typeof out.encoderImplementation === 'string' ? out.encoderImplementation : null,
    },
    counters: { at: now, bytes, lost: 0, received: 0, jbDelay: 0, jbEmitted: 0 },
  };
}

export function summarizeRecv(list: Rec[], prev: Counters | null, now: number): { stats: VideoRecvStats; counters: Counters } | null {
  const inb = list.find((r) => r.type === 'inbound-rtp' && r.kind === 'video');
  if (!inb) return null;
  const bytes = num(inb.bytesReceived) ?? 0;
  const lost = Math.max(0, num(inb.packetsLost) ?? 0);
  const received = num(inb.packetsReceived) ?? 0;
  let loss: number | null = null;
  if (prev) {
    const dl = Math.max(0, lost - prev.lost);
    const dr = Math.max(0, received - prev.received);
    loss = dl + dr > 0 ? dl / (dl + dr) : 0;
  }
  const delay = num(inb.jitterBufferDelay) ?? 0;
  const emitted = num(inb.jitterBufferEmittedCount) ?? 0;
  // Atraso médio do último intervalo; a média desde o início esconderia mudanças (e incluiria pausas).
  const dDelay = prev ? delay - prev.jbDelay : delay;
  const dEmitted = prev ? emitted - prev.jbEmitted : emitted;
  const jitterBufferMs = dEmitted > 0 ? Math.round((dDelay / dEmitted) * 1000) : null;
  const r = rtt(list);
  return {
    stats: {
      width: num(inb.frameWidth),
      height: num(inb.frameHeight),
      fps: num(inb.framesPerSecond),
      kbps: kbpsFrom(bytes, prev, now),
      loss,
      jitterBufferMs,
      rttMs: r,
      latencyMs: r != null && jitterBufferMs != null ? Math.round(r / 2 + jitterBufferMs) : null,
      framesDropped: num(inb.framesDropped),
      freezes: num(inb.freezeCount),
      decoder: typeof inb.decoderImplementation === 'string' ? inb.decoderImplementation : null,
    },
    counters: { at: now, bytes, lost, received, jbDelay: delay, jbEmitted: emitted },
  };
}

/** Lista de RTCStatsReport → registros simples. */
export const toList = (report: RTCStatsReport): Rec[] => {
  const out: Rec[] = [];
  report.forEach((r) => out.push(r as Rec));
  return out;
};

/** Por que a imagem está abaixo do escolhido, em português, para quem transmite. */
export function explainSend(s: VideoSendStats, wanted: { height: number; fps: number }, adaptReason: string | null): string[] {
  const why: string[] = [];
  if (s.sourceHeight != null && s.sourceHeight < wanted.height * 0.95) {
    why.push(`A fonte capturada tem ${s.sourceHeight}p: a imagem não é ampliada além disso.`);
  }
  if (s.limitation === 'bandwidth') why.push('Rede limitada: o codificador reduziu a qualidade para não travar.');
  if (s.limitation === 'cpu') why.push('Processador sobrecarregado: o codificador reduziu resolução ou FPS.');
  if (adaptReason) why.push(adaptReason);
  if (s.sourceFps != null && s.sourceFps < wanted.fps * 0.8 && s.sourceFps > 0) {
    why.push(`A captura está entregando ${Math.round(s.sourceFps)} FPS (conteúdo parado ou limite do sistema).`);
  }
  return why;
}
