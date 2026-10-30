import { describe, expect, it } from 'vitest';
import { tuneOpus } from '../opus';
import { VIDEO_LEVELS, adaptVideo, initialVideoAdapt } from './adapt';
import { MAX_KBPS, captureOptions, degradationFor, encodingFor, estimatedUploadKbps, targetKbps } from './quality';
import { explainSend, summarizeRecv, summarizeSend } from './stats';

describe('qualidade', () => {
  it('bitrate cresce com resolução e FPS, texto gasta menos e há teto', () => {
    expect(targetKbps({ resolution: '720p', fps: 30, content: 'motion' })).toBe(2500);
    expect(targetKbps({ resolution: '720p', fps: 60, content: 'motion' })).toBe(3750);
    expect(targetKbps({ resolution: '720p', fps: 30, content: 'detail' })).toBeLessThan(2500);
    expect(targetKbps({ resolution: '2160p', fps: 60, content: 'motion' })).toBe(MAX_KBPS);
  });

  it('captura usa resolução/FPS como máximo e só pede áudio quando marcado', () => {
    const o = captureOptions({ resolution: '1080p', fps: 60, content: 'motion' }, false) as { video: MediaTrackConstraints; audio: unknown };
    expect(o.video.height).toEqual({ max: 1080 });
    expect(o.video.frameRate).toEqual({ ideal: 60, max: 60 });
    expect(o.audio).toBe(false);
    const a = captureOptions({ resolution: '720p', fps: 30, content: 'motion' }, true) as { audio: MediaTrackConstraints };
    // Áudio da tela sem processamento de voz (estragaria música e efeitos).
    expect(a.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });

  it('reduz no codificador se a captura vier maior que o pedido e aplica o fator da rede', () => {
    const q = { resolution: '720p', fps: 30, content: 'motion' } as const;
    expect(encodingFor(q, { height: 1440 }).scaleResolutionDownBy).toBe(2);
    expect(encodingFor(q, { height: 600 }).scaleResolutionDownBy).toBe(1);
    expect(encodingFor(q, { height: null }, 0.5).maxBitrate).toBe(1_250_000);
    expect(encodingFor(q, { height: 720 }).maxFramerate).toBe(30);
  });

  it('jogo mantém fluidez; texto mantém nitidez', () => {
    expect(degradationFor('motion')).toBe('maintain-framerate');
    expect(degradationFor('detail')).toBe('maintain-resolution');
  });

  it('estimativa de envio multiplica por espectador (P2P)', () => {
    expect(estimatedUploadKbps({ resolution: '1080p', fps: 30, content: 'motion' }, 3)).toBe(13_500);
  });
});

const sendReport = (bytes: number, extra: Record<string, unknown> = {}) => [
  { type: 'media-source', id: 'ms', kind: 'video', width: 1920, height: 1080, framesPerSecond: 30 },
  { type: 'outbound-rtp', id: 'o', kind: 'video', mediaSourceId: 'ms', frameWidth: 1280, frameHeight: 720, framesPerSecond: 29, bytesSent: bytes, qualityLimitationReason: 'bandwidth', encoderImplementation: 'libvpx', ...extra },
  { type: 'remote-inbound-rtp', id: 'r', kind: 'video', fractionLost: 0.02, roundTripTime: 0.045 },
];

describe('estatísticas de vídeo', () => {
  it('lado de quem transmite: resolução real, fonte, taxa, perda, RTT e motivo da limitação', () => {
    const a = summarizeSend(sendReport(0), null, 0)!;
    expect(a.stats.kbps).toBeNull(); // primeira amostra não tem taxa
    const b = summarizeSend(sendReport(250_000), a.counters, 1000)!;
    expect(b.stats).toMatchObject({ width: 1280, height: 720, fps: 29, sourceHeight: 1080, kbps: 2000, loss: 0.02, rttMs: 45, limitation: 'bandwidth', encoder: 'libvpx' });
  });

  it('lado de quem assiste: perda por intervalo, buffer e latência estimada', () => {
    const r = (bytes: number, lost: number, received: number, jb = 4, jbn = 100) => [
      { type: 'candidate-pair', id: 'cp', nominated: true, state: 'succeeded', currentRoundTripTime: 0.06 },
      { type: 'inbound-rtp', id: 'i', kind: 'video', frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, bytesReceived: bytes, packetsLost: lost, packetsReceived: received, jitterBufferDelay: jb, jitterBufferEmittedCount: jbn, framesDropped: 3, freezeCount: 1 },
    ];
    const a = summarizeRecv(r(0, 0, 0, 30, 100), null, 0)!; // começo com buffer alto (300 ms)
    const b = summarizeRecv(r(500_000, 10, 990, 34, 200), a.counters, 2000)!; // último intervalo: 4 s / 100 quadros = 40 ms
    expect(b.stats).toMatchObject({ kbps: 2000, loss: 0.01, jitterBufferMs: 40, rttMs: 60, latencyMs: 70, framesDropped: 3, freezes: 1 });
  });

  it('sem vídeo no relatório devolve null', () => {
    expect(summarizeSend([{ type: 'outbound-rtp', id: 'a', kind: 'audio' }], null, 0)).toBeNull();
    expect(summarizeRecv([], null, 0)).toBeNull();
  });

  it('explica por que está abaixo do escolhido', () => {
    const s = summarizeSend(sendReport(0, { qualityLimitationReason: 'cpu' }), null, 0)!.stats;
    const why = explainSend({ ...s, sourceHeight: 900 }, { height: 1080, fps: 30 }, null);
    expect(why.join(' ')).toMatch(/fonte capturada tem 900p/);
    expect(why.join(' ')).toMatch(/Processador/);
    expect(explainSend({ ...s, limitation: 'none' }, { height: 1080, fps: 30 }, null)).toEqual([]);
  });
});

describe('adaptação do vídeo por espectador', () => {
  const bad = { loss: 0.1, rttMs: 50, limitation: 'none' as const };
  const good = { loss: 0, rttMs: 30, limitation: 'none' as const };

  it('desce um nível após 2 amostras ruins e informa o motivo', () => {
    let s = adaptVideo(initialVideoAdapt(), bad);
    expect(s.level).toBe(0);
    s = adaptVideo(s, bad);
    expect(s.level).toBe(1);
    expect(s.reason).toMatch(/Perda de 10%/);
  });

  it('latência alta persistente também reduz', () => {
    let s = initialVideoAdapt();
    for (let i = 0; i < 2; i++) s = adaptVideo(s, { loss: 0, rttMs: 600, limitation: 'none' });
    expect(s.level).toBe(1);
    expect(s.reason).toMatch(/Latência alta/);
  });

  it('a limitação "bandwidth" do codificador sozinha não reduz o teto (evita o ciclo de queda observado em teste)', () => {
    let s = initialVideoAdapt();
    for (let i = 0; i < 10; i++) s = adaptVideo(s, { loss: 0, rttMs: 30, limitation: 'bandwidth' });
    expect(s.level).toBe(0);
    // ...e não impede a recuperação depois de perda real.
    s = { level: 2, bad: 0, good: 0, reason: 'x' };
    for (let i = 0; i < 5; i++) s = adaptVideo(s, { loss: 0, rttMs: 30, limitation: 'bandwidth' });
    expect(s.level).toBe(1);
  });

  it('sobe devagar (5 amostras boas) e não passa dos limites', () => {
    let s = initialVideoAdapt();
    for (let i = 0; i < 20; i++) s = adaptVideo(s, bad);
    expect(s.level).toBe(VIDEO_LEVELS.length - 1);
    for (let i = 0; i < 4; i++) s = adaptVideo(s, good);
    expect(s.level).toBe(VIDEO_LEVELS.length - 1);
    s = adaptVideo(s, good);
    expect(s.level).toBe(VIDEO_LEVELS.length - 2);
    for (let i = 0; i < 100; i++) s = adaptVideo(s, good);
    expect(s.level).toBe(0);
    expect(s.reason).toBeNull();
  });

  it('processador sobrecarregado não muda o bitrate (baixar banda não resolve CPU)', () => {
    let s = initialVideoAdapt();
    for (let i = 0; i < 5; i++) s = adaptVideo(s, { loss: 0, rttMs: 30, limitation: 'cpu' });
    expect(s.level).toBe(0);
  });
});

describe('tuneOpus com transmissão', () => {
  const section = (pt: number) => [`m=audio 9 UDP/TLS/RTP/SAVPF ${pt}`, `a=rtpmap:${pt} opus/48000/2`, `a=fmtp:${pt} minptime=10`].join('\r\n');
  const sdp = ['v=0', section(111), 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', section(111), ''].join('\r\n');

  it('microfone fica mono com DTX; áudio da tela fica estéreo, sem DTX e com bitrate alto', () => {
    const out = tuneOpus(sdp).split('\r\n').filter((l) => l.startsWith('a=fmtp:111'));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('stereo=0');
    expect(out[0]).toContain('usedtx=1');
    expect(out[1]).toContain('stereo=1');
    expect(out[1]).toContain('usedtx=0');
    expect(out[1]).toContain('maxaveragebitrate=128000');
  });

  it('não mexe em seções de vídeo', () => {
    expect(tuneOpus(sdp)).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000');
  });
});
