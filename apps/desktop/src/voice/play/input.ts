/**
 * Jogar Juntos — protocolo de entrada e a guarda do lado de quem hospeda.
 *
 * Toda entrada que chega pela conexão P2P passa por aqui ANTES de qualquer efeito:
 *  1. formato estrito (mensagem desconhecida ou fora dos limites é descartada);
 *  2. só de quem o servidor diz que controla, só dos tipos concedidos e dentro do prazo;
 *  3. teclas e combinações que saem do jogo (Windows, Alt+Tab, Alt+F4, Ctrl+Esc...) são bloqueadas;
 *  4. limite de taxa (uma conexão não pode inundar o sistema de eventos).
 * Funções puras: testáveis sem navegador.
 */
import type { PlayControl } from '@nexo/protocol';

export type InputMsg =
  /** Tecla (KeyboardEvent.code) pressionada/solta. */
  | { t: 'k'; c: string; d: boolean }
  /** Posição do mouse, normalizada 0–1 sobre a imagem transmitida. */
  | { t: 'm'; x: number; y: number }
  /** Botão do mouse: 0 esquerdo, 1 meio, 2 direito. */
  | { t: 'b'; b: 0 | 1 | 2; d: boolean }
  /** Rolagem (linhas, ±). */
  | { t: 'w'; dy: number }
  /** Soltar tudo (perdeu o foco, devolveu o controle). */
  | { t: 'r' };

export const MAX_INPUT_BYTES = 128;
const CODE_RE = /^[A-Za-z0-9]{1,24}$/;

/** Interpreta uma mensagem recebida. Qualquer coisa fora do formato vira null. */
export function parseInput(raw: unknown): InputMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT_BYTES) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  switch (m.t) {
    case 'k':
      return typeof m.c === 'string' && CODE_RE.test(m.c) && typeof m.d === 'boolean' ? { t: 'k', c: m.c, d: m.d } : null;
    case 'm':
      return fin(m.x) && fin(m.y) ? { t: 'm', x: clamp01(m.x), y: clamp01(m.y) } : null;
    case 'b':
      return (m.b === 0 || m.b === 1 || m.b === 2) && typeof m.d === 'boolean' ? { t: 'b', b: m.b, d: m.d } : null;
    case 'w':
      return fin(m.dy) ? { t: 'w', dy: Math.max(-10, Math.min(10, Math.round(m.dy))) } : null;
    case 'r':
      return { t: 'r' };
    default:
      return null;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Teclas que nunca são repassadas: abrem o menu Iniciar/atalhos do sistema fora do jogo. */
export const BLOCKED_KEYS = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'ContextMenu', 'PrintScreen', 'Power', 'Sleep', 'WakeUp']);

const isAlt = (c: string) => c === 'AltLeft' || c === 'AltRight';
const isCtrl = (c: string) => c === 'ControlLeft' || c === 'ControlRight';
const isShift = (c: string) => c === 'ShiftLeft' || c === 'ShiftRight';

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Estado da guarda para UMA sessão de controle (recriar a cada nova autorização).
 * Guarda as teclas/botões pressionados para (a) detectar combinações e (b) soltar tudo ao final.
 */
export class InputGuard {
  readonly heldKeys = new Set<string>();
  readonly heldButtons = new Set<number>();
  private tokens: number;
  private last: number;
  accepted = 0;
  blocked = 0;
  lastBlockReason: string | null = null;

  /** `rate` eventos/s com rajada de `burst` (mouse a 120 Hz + teclas cabem com folga). */
  constructor(
    private readonly rate = 400,
    private readonly burst = 200,
    now = 0,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  check(from: string, msg: InputMsg, control: PlayControl | null, now: number): Verdict {
    const v = this.decide(from, msg, control, now);
    if (v.ok) {
      this.accepted++;
      if (msg.t === 'k') (msg.d ? this.heldKeys.add(msg.c) : this.heldKeys.delete(msg.c));
      if (msg.t === 'b') (msg.d ? this.heldButtons.add(msg.b) : this.heldButtons.delete(msg.b));
      if (msg.t === 'r') {
        this.heldKeys.clear();
        this.heldButtons.clear();
      }
    } else {
      this.blocked++;
      this.lastBlockReason = v.reason;
    }
    return v;
  }

  private decide(from: string, msg: InputMsg, control: PlayControl | null, now: number): Verdict {
    if (!control || control.guestId !== from) return { ok: false, reason: 'sem autorização' };
    if (Date.parse(control.expiresAt) <= now) return { ok: false, reason: 'autorização expirada' };
    // "Soltar tudo" é sempre aceito de quem controla: só pode diminuir o efeito.
    if (msg.t === 'r') return { ok: true };
    if (msg.t === 'k' && !control.keyboard) return { ok: false, reason: 'teclado não autorizado' };
    if ((msg.t === 'm' || msg.t === 'b' || msg.t === 'w') && !control.mouse) return { ok: false, reason: 'mouse não autorizado' };

    // Taxa (balde de fichas). Soltar tecla/botão nunca é barrado: evita tecla "presa".
    const releasing = (msg.t === 'k' || msg.t === 'b') && !msg.d;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (!releasing) {
      if (this.tokens < 1) return { ok: false, reason: 'eventos demais' };
      this.tokens -= 1;
    }

    if (msg.t === 'k' && msg.d) {
      if (BLOCKED_KEYS.has(msg.c)) return { ok: false, reason: `tecla ${msg.c} bloqueada` };
      const held = [...this.heldKeys];
      const alt = held.some(isAlt), ctrl = held.some(isCtrl), shift = held.some(isShift);
      if (alt && (msg.c === 'Tab' || msg.c === 'F4' || msg.c === 'Escape')) return { ok: false, reason: `Alt+${msg.c} bloqueado` };
      if (ctrl && msg.c === 'Escape') return { ok: false, reason: shift ? 'Ctrl+Shift+Esc bloqueado' : 'Ctrl+Esc bloqueado' };
      if (ctrl && alt && msg.c === 'Delete') return { ok: false, reason: 'Ctrl+Alt+Del bloqueado' };
    }
    return { ok: true };
  }
}

/**
 * Converte um ponto da tela de quem controla em coordenadas normalizadas da imagem transmitida,
 * considerando as faixas pretas do `object-fit: contain`. Fora da imagem → null (não move o mouse).
 */
export function videoPoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number },
): { x: number; y: number } | null {
  if (!video.width || !video.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const w = video.width * scale, h = video.height * scale;
  const left = box.left + (box.width - w) / 2, top = box.top + (box.height - h) / 2;
  const x = (clientX - left) / w, y = (clientY - top) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** Descrição curta de um evento, para o monitor de entradas do anfitrião. */
export function describeInput(m: InputMsg): string {
  switch (m.t) {
    case 'k':
      return `${m.d ? '↓' : '↑'} ${m.c.replace(/^Key/, '').replace(/^Digit/, '')}`;
    case 'm':
      return `mouse ${(m.x * 100).toFixed(0)}%, ${(m.y * 100).toFixed(0)}%`;
    case 'b':
      return `${m.d ? '↓' : '↑'} botão ${['esquerdo', 'do meio', 'direito'][m.b]}`;
    case 'w':
      return `rolagem ${m.dy > 0 ? '↓' : '↑'}${Math.abs(m.dy)}`;
    case 'r':
      return 'soltar tudo';
  }
}
