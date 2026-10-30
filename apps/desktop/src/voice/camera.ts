/**
 * Câmera: presets, restrições de captura, parâmetros do codificador e preferências locais.
 * A câmera escolhida fica só neste computador (o id de dispositivo não faz sentido em outra máquina).
 */
import type { EncodingParams } from './screen/quality';

export const CAMERA_QUALITIES = {
  '360p': { width: 640, height: 360, fps: 30, kbps: 600, label: '360p (economiza banda)' },
  '720p': { width: 1280, height: 720, fps: 30, kbps: 1500, label: '720p (HD)' },
} as const;
export type CameraQuality = keyof typeof CAMERA_QUALITIES;

export interface CameraPrefs {
  deviceId: string;
  quality: CameraQuality;
  /** Espelhar a própria prévia (como um espelho). Só afeta o que você vê, nunca o que os outros recebem. */
  mirror: boolean;
}

export const DEFAULT_CAMERA_PREFS: CameraPrefs = { deviceId: 'default', quality: '360p', mirror: true };
const KEY = 'nexo.camera';

export function loadCameraPrefs(): CameraPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CameraPrefs> | null;
    if (!v) return DEFAULT_CAMERA_PREFS;
    return {
      deviceId: typeof v.deviceId === 'string' && v.deviceId.length <= 256 ? v.deviceId : 'default',
      quality: v.quality && v.quality in CAMERA_QUALITIES ? v.quality : '360p',
      mirror: typeof v.mirror === 'boolean' ? v.mirror : true,
    };
  } catch {
    return DEFAULT_CAMERA_PREFS;
  }
}

export function saveCameraPrefs(p: CameraPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* sem armazenamento local */
  }
}

/** Restrições do getUserMedia. "ideal" (não "exact"): câmeras que não suportam o pedido ainda abrem. */
export function cameraConstraints(q: CameraQuality, deviceId: string): MediaStreamConstraints {
  const c = CAMERA_QUALITIES[q];
  return {
    audio: false,
    video: {
      ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: c.width },
      height: { ideal: c.height },
      frameRate: { ideal: c.fps, max: c.fps },
    },
  };
}

/** Se a câmera entregar mais que o pedido (comum: 1080p fixo), o codificador reduz. */
export function cameraEncoding(q: CameraQuality, captured: { height: number | null }): EncodingParams {
  const c = CAMERA_QUALITIES[q];
  const scale = captured.height && captured.height > c.height ? captured.height / c.height : 1;
  return { maxBitrate: c.kbps * 1000, maxFramerate: c.fps, scaleResolutionDownBy: Math.round(scale * 100) / 100 };
}

/** Mensagens claras para os erros do getUserMedia. */
export function cameraErrorMessage(err: unknown): string {
  switch ((err as DOMException)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'O acesso à câmera foi negado. Libere nas permissões do sistema/navegador.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Nenhuma câmera foi encontrada.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'A câmera está em uso por outro aplicativo ou indisponível.';
    case 'OverconstrainedError':
      return 'A câmera escolhida não está disponível. Escolha outra nas configurações.';
    default:
      return 'Não foi possível ligar a câmera.';
  }
}
