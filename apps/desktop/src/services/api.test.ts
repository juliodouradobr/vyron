import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, describeError } from './api';

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('createApiClient', () => {
  it('envia o token Bearer só em rotas autenticadas', async () => {
    const fetchImpl = vi.fn(() => json(200, {}));
    const api = createApiClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as never, getToken: () => 'nx_abc' });
    await api.me();
    await api.login({ username: 'a', password: 'b' });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer nx_abc');
    expect((calls[1]![1].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('converte erros do servidor em ApiError com código', async () => {
    const api = createApiClient({
      baseUrl: 'http://x',
      fetchImpl: (() => json(409, { error: { code: 'USERNAME_TAKEN', message: 'em uso' } })) as never,
      getToken: () => null,
    });
    await expect(api.register({ username: 'a', password: 'b' })).rejects.toMatchObject({ code: 'USERNAME_TAKEN', status: 409 });
  });

  it('distingue falha de rede', async () => {
    const api = createApiClient({ baseUrl: 'http://x', fetchImpl: (() => Promise.reject(new TypeError('falhou'))) as never, getToken: () => null });
    await expect(api.health()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('avisa sessão encerrada em 401 autenticado, mas não no login', async () => {
    const onUnauthorized = vi.fn();
    const api = createApiClient({
      baseUrl: 'http://x',
      fetchImpl: (() => json(401, { error: { code: 'SESSION_EXPIRED', message: 'expirou' } })) as never,
      getToken: () => 'nx_t',
      onUnauthorized,
    });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledWith('SESSION_EXPIRED');
    onUnauthorized.mockClear();
    await expect(api.login({ username: 'a', password: 'b' })).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('describeError', () => {
  it('inclui o tempo de espera em bloqueios', () => {
    expect(describeError(new ApiError('ACCOUNT_LOCKED', 'Muitas tentativas.', 429, 900))).toBe('Muitas tentativas. Tente novamente em 15 min.');
    expect(describeError(new ApiError('RATE_LIMITED', 'Devagar.', 429, 30))).toBe('Devagar. Tente novamente em 30s.');
  });
});
