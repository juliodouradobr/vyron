import { describe, expect, it } from 'vitest';
import type { PlayControl } from '@nexo/protocol';
import { InputGuard, parseInput, videoPoint } from './input';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const ctl = (p: Partial<PlayControl> = {}): PlayControl => ({
  guestId: 'convidado',
  keyboard: true,
  mouse: true,
  gamepad: false,
  grantedAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  ...p,
});

describe('parseInput', () => {
  it('aceita só o formato conhecido', () => {
    expect(parseInput('{"t":"k","c":"KeyW","d":true}')).toEqual({ t: 'k', c: 'KeyW', d: true });
    expect(parseInput('{"t":"m","x":0.5,"y":2}')).toEqual({ t: 'm', x: 0.5, y: 1 }); // fora da faixa: limitado
    expect(parseInput('{"t":"w","dy":99}')).toEqual({ t: 'w', dy: 10 });
    for (const bad of ['{"t":"k","c":"Key W","d":true}', '{"t":"k","c":"KeyW"}', '{"t":"x"}', '{"t":"b","b":7,"d":true}', 'nada', 42, '{"t":"m","x":"1","y":0}', `{"t":"k","c":"${'A'.repeat(200)}","d":true}`]) {
      expect(parseInput(bad)).toBeNull();
    }
  });
});

describe('InputGuard', () => {
  const k = (c: string, d = true) => ({ t: 'k' as const, c, d });

  it('só aceita de quem o servidor diz que controla, dentro do prazo', () => {
    const g = new InputGuard(400, 200, NOW);
    expect(g.check('convidado', k('KeyW'), ctl(), NOW)).toEqual({ ok: true });
    expect(g.check('outra-pessoa', k('KeyW'), ctl(), NOW)).toMatchObject({ ok: false, reason: 'sem autorização' });
    expect(g.check('convidado', k('KeyW'), null, NOW)).toMatchObject({ ok: false });
    expect(g.check('convidado', k('KeyW'), ctl({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toMatchObject({ ok: false, reason: 'autorização expirada' });
  });

  it('respeita o tipo de entrada concedido', () => {
    const g = new InputGuard(400, 200, NOW);
    expect(g.check('convidado', k('KeyW'), ctl({ keyboard: false }), NOW)).toMatchObject({ ok: false, reason: 'teclado não autorizado' });
    expect(g.check('convidado', { t: 'm', x: 0.1, y: 0.1 }, ctl({ mouse: false }), NOW)).toMatchObject({ ok: false, reason: 'mouse não autorizado' });
    expect(g.check('convidado', { t: 'b', b: 0, d: true }, ctl({ mouse: false }), NOW)).toMatchObject({ ok: false });
    expect(g.check('convidado', { t: 'm', x: 0.1, y: 0.1 }, ctl({ keyboard: false }), NOW)).toEqual({ ok: true });
  });

  it('bloqueia teclas e combinações que saem do jogo', () => {
    const g = new InputGuard(400, 200, NOW);
    expect(g.check('convidado', k('MetaLeft'), ctl(), NOW)).toMatchObject({ ok: false });
    g.check('convidado', k('AltLeft'), ctl(), NOW);
    expect(g.check('convidado', k('Tab'), ctl(), NOW)).toMatchObject({ ok: false, reason: 'Alt+Tab bloqueado' });
    expect(g.check('convidado', k('F4'), ctl(), NOW)).toMatchObject({ ok: false, reason: 'Alt+F4 bloqueado' });
    g.check('convidado', k('AltLeft', false), ctl(), NOW);
    expect(g.check('convidado', k('Tab'), ctl(), NOW)).toEqual({ ok: true }); // Tab sozinho é do jogo
    g.check('convidado', k('ControlLeft'), ctl(), NOW);
    g.check('convidado', k('ShiftLeft'), ctl(), NOW);
    expect(g.check('convidado', k('Escape'), ctl(), NOW)).toMatchObject({ ok: false, reason: 'Ctrl+Shift+Esc bloqueado' });
    expect(g.blocked).toBe(4);
  });

  it('limita a taxa, mas nunca barra soltar (sem teclas presas)', () => {
    const g = new InputGuard(10, 5, NOW);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (g.check('convidado', { t: 'm', x: 0.5, y: 0.5 }, ctl(), NOW).ok) ok++;
    expect(ok).toBe(5);
    expect(g.check('convidado', k('KeyW', false), ctl(), NOW)).toEqual({ ok: true });
    expect(g.check('convidado', { t: 'm', x: 0.5, y: 0.5 }, ctl(), NOW + 1000).ok).toBe(true); // fichas repostas com o tempo
  });

  it('acompanha o que está pressionado para soltar tudo no fim', () => {
    const g = new InputGuard(400, 200, NOW);
    g.check('convidado', k('KeyW'), ctl(), NOW);
    g.check('convidado', { t: 'b', b: 0, d: true }, ctl(), NOW);
    expect([...g.heldKeys]).toEqual(['KeyW']);
    expect([...g.heldButtons]).toEqual([0]);
    g.check('convidado', { t: 'r' }, ctl(), NOW);
    expect(g.heldKeys.size + g.heldButtons.size).toBe(0);
  });
});

describe('videoPoint', () => {
  const box = { left: 0, top: 0, width: 1000, height: 1000 };
  it('desconta as faixas pretas do object-fit: contain', () => {
    // Vídeo 16:9 numa caixa quadrada: altura útil 562,5, faixas de ~218,75 em cima e embaixo.
    expect(videoPoint(500, 500, box, { width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
    const corner = videoPoint(0, 218.75, box, { width: 1920, height: 1080 })!;
    expect(corner.x).toBeCloseTo(0, 9);
    expect(corner.y).toBeCloseTo(0, 9);
    expect(videoPoint(500, 100, box, { width: 1920, height: 1080 })).toBeNull(); // na faixa preta
  });
  it('sem dimensões ainda (vídeo carregando) → null', () => {
    expect(videoPoint(1, 1, box, { width: 0, height: 0 })).toBeNull();
  });
});
