import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';

/**
 * Persistência do token de sessão.
 * - Tauri: Gerenciador de Credenciais do Windows (DPAPI) via comandos nativos — o token não
 *   fica em arquivos legíveis nem no armazenamento do WebView.
 * - Navegador (somente desenvolvimento): localStorage.
 */
const KEY = 'nexo.session';

export const tokenStore = {
  async get(): Promise<string | null> {
    if (isTauri()) return (await invoke<string | null>('auth_token_get')) ?? null;
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  async set(token: string): Promise<void> {
    if (isTauri()) return invoke('auth_token_set', { token });
    try {
      localStorage.setItem(KEY, token);
    } catch {
      /* armazenamento indisponível: a sessão vale só até fechar a janela */
    }
  },
  async clear(): Promise<void> {
    if (isTauri()) return invoke('auth_token_clear');
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nada a limpar */
    }
  },
};
