/**
 * Jogar Juntos, lado de quem controla: captura teclado e mouse SÓ sobre a área da transmissão,
 * só enquanto o modo "Controlar" estiver ligado e o elemento estiver em foco.
 * Perder o foco solta tudo do outro lado (sem teclas presas).
 */
import { videoPoint, type InputMsg } from './input';

const MOVE_EVERY_MS = 8; // ~120 Hz

export function attachCapture(
  el: HTMLElement,
  video: HTMLVideoElement,
  send: (m: InputMsg) => void,
  allow: { keyboard: boolean; mouse: boolean },
): () => void {
  let lastMove = 0;
  const pressed = new Set<string>();

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (!allow.keyboard) return;
    // Atalho de pânico fica com o app (tratado globalmente), nunca vai para o outro lado.
    if (e.code === 'F12' && e.ctrlKey && e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (down && e.repeat) return; // a repetição é gerada do lado de lá, enquanto a tecla estiver pressionada
    if (down) pressed.add(e.code);
    else pressed.delete(e.code);
    send({ t: 'k', c: e.code, d: down });
  };
  const point = (e: PointerEvent | MouseEvent) => {
    const r = video.getBoundingClientRect();
    return videoPoint(e.clientX, e.clientY, r, { width: video.videoWidth, height: video.videoHeight });
  };
  const onMove = (e: PointerEvent) => {
    if (!allow.mouse) return;
    const now = performance.now();
    if (now - lastMove < MOVE_EVERY_MS) return;
    const p = point(e);
    if (!p) return;
    lastMove = now;
    send({ t: 'm', x: p.x, y: p.y });
  };
  const onButton = (down: boolean) => (e: PointerEvent) => {
    if (!allow.mouse) return;
    const b = e.button === 1 ? 1 : e.button === 2 ? 2 : e.button === 0 ? 0 : null;
    if (b === null) return;
    const p = point(e);
    if (down && !p) return; // clique fora da imagem (nas faixas pretas) não vale
    e.preventDefault();
    el.focus();
    if (p) send({ t: 'm', x: p.x, y: p.y });
    send({ t: 'b', b, d: down });
  };
  const onWheel = (e: WheelEvent) => {
    if (!allow.mouse) return;
    e.preventDefault();
    const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 100));
    if (e.deltaY !== 0) send({ t: 'w', dy: Math.sign(e.deltaY) * lines });
  };
  const noMenu = (e: Event) => e.preventDefault();
  const release = () => {
    pressed.clear();
    send({ t: 'r' });
  };

  const kd = onKey(true), ku = onKey(false), bd = onButton(true), bu = onButton(false);
  el.addEventListener('keydown', kd);
  el.addEventListener('keyup', ku);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerdown', bd);
  el.addEventListener('pointerup', bu);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', noMenu);
  el.addEventListener('blur', release);
  el.focus();
  return () => {
    el.removeEventListener('keydown', kd);
    el.removeEventListener('keyup', ku);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerdown', bd);
    el.removeEventListener('pointerup', bu);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', noMenu);
    el.removeEventListener('blur', release);
    release();
  };
}
