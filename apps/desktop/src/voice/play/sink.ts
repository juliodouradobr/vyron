/**
 * Para onde vão as entradas já aprovadas pela guarda (input.ts), do lado de quem hospeda.
 *
 * - Aplicativo para Windows: o núcleo nativo (Rust) injeta via SendInput, mas SÓ na janela que o
 *   anfitrião escolheu e só enquanto ela estiver em primeiro plano; ele confere de novo os tipos
 *   autorizados. Atalho de pânico global encerra tudo.
 * - Navegador: não existe forma (nem deveria existir) de uma página controlar o computador. Aqui as
 *   entradas são apenas MOSTRADAS ao anfitrião no monitor de entradas — nada chega ao sistema.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../services/platform';
import type { InputMsg } from './input';

export interface TargetWindow {
  id: number;
  title: string;
  process: string;
}

export interface InputSink {
  readonly kind: 'native' | 'monitor';
  arm(opts: { keyboard: boolean; mouse: boolean; windowId: number | null }): Promise<void>;
  apply(m: InputMsg): void;
  /** Solta tudo o que estiver pressionado e para de aceitar entradas. */
  disarm(): Promise<void>;
}

export class NativeSink implements InputSink {
  readonly kind = 'native' as const;
  async arm(opts: { keyboard: boolean; mouse: boolean; windowId: number | null }) {
    if (opts.windowId == null) throw new Error('Escolha a janela do jogo.');
    await invoke('play_arm', { windowId: opts.windowId, keyboard: opts.keyboard, mouse: opts.mouse });
  }
  apply(m: InputMsg) {
    void invoke('play_input', { event: m }).catch(() => {});
  }
  async disarm() {
    await invoke('play_disarm').catch(() => {});
  }
}

export class MonitorSink implements InputSink {
  readonly kind = 'monitor' as const;
  constructor(private readonly onEvent: (m: InputMsg) => void) {}
  async arm() {}
  apply(m: InputMsg) {
    this.onEvent(m);
  }
  async disarm() {}
}

export const nativeInputAvailable = isTauri;

/** Janelas visíveis que podem receber o controle (só no aplicativo para Windows). */
export async function listTargetWindows(): Promise<TargetWindow[]> {
  if (!isTauri()) return [];
  return invoke<TargetWindow[]>('play_list_windows');
}
