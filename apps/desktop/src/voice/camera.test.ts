import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_PREFS, cameraConstraints, cameraEncoding, cameraErrorMessage, loadCameraPrefs, saveCameraPrefs } from './camera';

afterEach(() => localStorage.clear());

describe('câmera', () => {
  it('restrições usam "ideal" (abre mesmo em câmeras limitadas), sem áudio, e só fixa o dispositivo se escolhido', () => {
    const c = cameraConstraints('720p', 'default') as { audio: boolean; video: MediaTrackConstraints };
    expect(c.audio).toBe(false);
    expect(c.video.height).toEqual({ ideal: 720 });
    expect(c.video.frameRate).toEqual({ ideal: 30, max: 30 });
    expect(c.video.deviceId).toBeUndefined();
    const d = cameraConstraints('360p', 'abc') as { video: MediaTrackConstraints };
    expect(d.video.deviceId).toEqual({ exact: 'abc' });
  });

  it('câmera que entrega 1080p fixo é reduzida no codificador', () => {
    expect(cameraEncoding('360p', { height: 1080 })).toEqual({ maxBitrate: 600_000, maxFramerate: 30, scaleResolutionDownBy: 3 });
    expect(cameraEncoding('720p', { height: 720 }).scaleResolutionDownBy).toBe(1);
    expect(cameraEncoding('720p', { height: null }).maxBitrate).toBe(1_500_000);
  });

  it('mensagens claras para os erros do sistema', () => {
    const e = (name: string) => cameraErrorMessage(new DOMException('x', name));
    expect(e('NotAllowedError')).toMatch(/negado/);
    expect(e('NotFoundError')).toMatch(/Nenhuma câmera/);
    expect(e('NotReadableError')).toMatch(/em uso/);
    expect(e('Outra')).toMatch(/Não foi possível/);
  });

  it('preferências ficam no computador e valores inválidos voltam ao padrão', () => {
    expect(loadCameraPrefs()).toEqual(DEFAULT_CAMERA_PREFS);
    saveCameraPrefs({ deviceId: 'cam-2', quality: '720p', mirror: false });
    expect(loadCameraPrefs()).toEqual({ deviceId: 'cam-2', quality: '720p', mirror: false });
    localStorage.setItem('nexo.camera', JSON.stringify({ deviceId: 5, quality: '4k', mirror: 'sim' }));
    expect(loadCameraPrefs()).toEqual(DEFAULT_CAMERA_PREFS);
    localStorage.setItem('nexo.camera', '{quebrado');
    expect(loadCameraPrefs()).toEqual(DEFAULT_CAMERA_PREFS);
  });
});
