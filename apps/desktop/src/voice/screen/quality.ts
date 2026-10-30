/**
 * Qualidade de transmissão de tela: o que a pessoa escolhe (resolução, FPS, tipo de conteúdo)
 * e como isso vira restrições de captura e parâmetros do codificador.
 * O que é escolhido é um teto: a qualidade real (negociada) depende da fonte, da rede e do processador,
 * e é medida separadamente (ver stats.ts).
 */

export const RESOLUTIONS = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
} as const;
export type ResolutionId = keyof typeof RESOLUTIONS;
export const RESOLUTION_IDS = Object.keys(RESOLUTIONS) as ResolutionId[];

export const FPS_OPTIONS = [15, 30, 60] as const;
export type Fps = (typeof FPS_OPTIONS)[number];

/** motion = jogo/vídeo (prioriza fluidez); detail = texto/código (prioriza nitidez). */
export type ContentKind = 'motion' | 'detail';

export interface StreamQuality {
  resolution: ResolutionId;
  fps: Fps;
  content: ContentKind;
}

export const DEFAULT_QUALITY: StreamQuality = { resolution: '720p', fps: 30, content: 'motion' };

/** Bitrate-alvo (kbps) a 30 FPS para conteúdo em movimento. Valores na faixa usual de VP8/VP9/H.264 para tela. */
const BASE_KBPS: Record<ResolutionId, number> = {
  '360p': 700,
  '480p': 1100,
  '720p': 2500,
  '1080p': 4500,
  '1440p': 8000,
  '2160p': 14_000,
};

const FPS_FACTOR: Record<Fps, number> = { 15: 0.6, 30: 1, 60: 1.5 };

/** Teto absoluto por espectador: acima disso a maioria das conexões domésticas não sustenta. */
export const MAX_KBPS = 20_000;

export function targetKbps(q: StreamQuality): number {
  // Texto parado comprime muito melhor que jogo: precisa de menos bits pela mesma nitidez.
  const content = q.content === 'detail' ? 0.75 : 1;
  return Math.min(MAX_KBPS, Math.round(BASE_KBPS[q.resolution] * FPS_FACTOR[q.fps] * content));
}

/**
 * Opções do getDisplayMedia. A resolução/FPS pedidos são máximos: a captura nunca aumenta a imagem
 * (uma tela 1080p capturada "em 1440p" continua 1080p). Áudio só quando a pessoa marcou a opção.
 */
export function captureOptions(q: StreamQuality, withAudio: boolean): DisplayMediaStreamOptions {
  const r = RESOLUTIONS[q.resolution];
  return {
    video: {
      width: { max: r.width },
      height: { max: r.height },
      frameRate: { ideal: q.fps, max: q.fps },
    },
    audio: withAudio
      ? // Áudio da tela vai como está: o processamento de voz estragaria música e efeitos do jogo.
        ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints)
      : false,
    // Opções do Chromium (ignoradas onde não existem). Não oferecer a própria janela do app evita o "espelho infinito".
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: withAudio ? 'include' : 'exclude',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions;
}

export interface EncodingParams {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

/**
 * Parâmetros do codificador para um espectador. `factor` (0–1) vem da adaptação à rede.
 * Se a captura veio maior que o pedido (alguns sistemas ignoram o máximo), reduzimos no codificador.
 */
export function encodingFor(q: StreamQuality, captured: { height: number | null }, factor = 1): EncodingParams {
  const wanted = RESOLUTIONS[q.resolution].height;
  const scale = captured.height && captured.height > wanted ? captured.height / wanted : 1;
  return {
    maxBitrate: Math.max(150_000, Math.round(targetKbps(q) * factor * 1000)),
    maxFramerate: q.fps,
    scaleResolutionDownBy: Math.round(scale * 100) / 100,
  };
}

/** Jogo: manter fluidez e reduzir resolução se faltar banda; texto: manter nitidez e reduzir FPS. */
export const degradationFor = (c: ContentKind): RTCDegradationPreference => (c === 'motion' ? 'maintain-framerate' : 'maintain-resolution');

/** Dica para o codificador sobre o tipo de imagem. */
export const contentHintFor = (c: ContentKind): string => (c === 'motion' ? 'motion' : 'detail');

/** Estimativa de envio total: em P2P, cada espectador recebe uma cópia. */
export const estimatedUploadKbps = (q: StreamQuality, viewers: number) => targetKbps(q) * Math.max(1, viewers);

export function describeSurface(s: string): string {
  return s === 'monitor' ? 'Tela inteira' : s === 'window' ? 'Janela' : s === 'browser' ? 'Aba do navegador' : 'Tela';
}
