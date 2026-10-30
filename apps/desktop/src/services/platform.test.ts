import { afterEach, describe, expect, it } from 'vitest';
import { getApiUrl, gatewayUrl, normalizeServerUrl, setApiUrl } from './platform';

afterEach(() => localStorage.clear());

describe('endereço do servidor', () => {
  it('normaliza o que a pessoa digita', () => {
    expect(normalizeServerUrl('vyron.exemplo.com')).toEqual({ url: 'https://vyron.exemplo.com' });
    expect(normalizeServerUrl('  https://Vyron.Exemplo.com/ ')).toEqual({ url: 'https://vyron.exemplo.com' });
    expect(normalizeServerUrl('vyron.exemplo.com:8443')).toEqual({ url: 'https://vyron.exemplo.com:8443' });
    expect(normalizeServerUrl('http://localhost:4100')).toEqual({ url: 'http://localhost:4100' });
    expect(normalizeServerUrl('http://127.0.0.1:4100')).toEqual({ url: 'http://127.0.0.1:4100' });
  });

  it('exige HTTPS na internet e recusa endereços estranhos', () => {
    expect(normalizeServerUrl('http://vyron.exemplo.com')).toMatchObject({ error: expect.stringMatching(/HTTPS/) });
    expect(normalizeServerUrl('http://192.168.0.10:4100')).toMatchObject({ error: expect.stringMatching(/HTTPS/) });
    expect(normalizeServerUrl('ftp://vyron.exemplo.com')).toHaveProperty('error');
    expect(normalizeServerUrl('https://user:senha@vyron.exemplo.com')).toHaveProperty('error');
    expect(normalizeServerUrl('https://vyron.exemplo.com/api')).toHaveProperty('error');
    expect(normalizeServerUrl('')).toHaveProperty('error');
    expect(normalizeServerUrl('não é endereço')).toHaveProperty('error');
  });

  it('guarda a escolha neste computador e deriva o gateway', () => {
    expect(getApiUrl()).toBe('http://127.0.0.1:4100'); // padrão do desenvolvimento
    setApiUrl('https://vyron.exemplo.com');
    expect(getApiUrl()).toBe('https://vyron.exemplo.com');
    expect(gatewayUrl()).toBe('wss://vyron.exemplo.com/gateway');
    // Valor adulterado no armazenamento local não é usado.
    localStorage.setItem('nexo.server', 'http://atacante.exemplo');
    expect(getApiUrl()).toBe('http://127.0.0.1:4100');
  });
});
