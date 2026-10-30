/** Detecta se o frontend roda dentro do shell Tauri ou num navegador comum (desenvolvimento). */
export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Servidor VYRON ao qual o app se conecta. O mesmo instalador serve para qualquer servidor: a pessoa
 * escolhe o endereço na tela de entrada (fica salvo neste computador). O padrão vem do build
 * (VITE_API_URL) e, sem ele, é o servidor local de desenvolvimento.
 */
const SERVER_KEY = 'nexo.server';
// Variável vazia no build conta como não definida.
const BUILD_DEFAULT = (import.meta.env.VITE_API_URL as string | undefined)?.trim() || 'http://127.0.0.1:4100';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Valida e normaliza o endereço digitado. Aceita "vyron.exemplo.com", "https://vyron.exemplo.com/"
 * ou "vyron.exemplo.com:8443". Exige HTTPS — senha, mensagens e token não podem trafegar sem
 * criptografia — exceto no próprio computador (desenvolvimento).
 */
export function normalizeServerUrl(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Informe o endereço do servidor.' };
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: 'Endereço inválido.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Use um endereço https://.' };
  if (u.username || u.password) return { error: 'O endereço não pode conter usuário ou senha.' };
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol === 'http:' && !local) {
    return { error: 'Servidores na internet precisam de HTTPS (https://). Sem isso, senha e mensagens trafegariam sem proteção.' };
  }
  if (u.pathname !== '/' || u.search || u.hash) return { error: 'Informe só o endereço do servidor, sem caminho (ex.: vyron.exemplo.com).' };
  return { url: `${u.protocol}//${u.host}` };
}

export function getApiUrl(): string {
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    if (saved) {
      const n = normalizeServerUrl(saved);
      if ('url' in n) return n.url;
    }
  } catch {
    /* sem armazenamento local */
  }
  return BUILD_DEFAULT;
}

export function setApiUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_KEY, url);
  } catch {
    /* sem armazenamento local: vale só nesta sessão */
  }
}

export const gatewayUrl = (): string => getApiUrl().replace(/^http/, 'ws') + '/gateway';

/** Só o nome do servidor, para exibir ("vyron.exemplo.com"). */
export const serverLabel = (url = getApiUrl()): string => url.replace(/^https?:\/\//, '');

export const APP_VERSION = '0.1.0';

/** Nome do dispositivo exibido em "Sessões ativas". Não inclui dados identificáveis do computador. */
export function clientName(): string {
  if (isTauri()) return 'VYRON para Windows';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : 'Navegador';
  return `VYRON Web (${browser})`;
}
