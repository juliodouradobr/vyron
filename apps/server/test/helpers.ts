import type { FastifyInstance } from 'fastify';
import type { RegisterResponse } from '@nexo/protocol';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createDb } from '../src/db';
import { migrate } from '../src/db/migrate';

type Overrides = { [K in keyof Config]?: Config[K] extends object ? Partial<Config[K]> : Config[K] };

export async function createTestApp(overrides: Overrides = {}): Promise<FastifyInstance> {
  const base = loadConfig({ LOG_LEVEL: 'silent' });
  const config: Config = {
    ...base,
    ...(overrides as Partial<Config>),
    auth: { ...base.auth, ...overrides.auth },
    gateway: { ...base.gateway, ...overrides.gateway },
    // Arquivos em memória nos testes: nada é escrito no disco.
    files: { ...base.files, dir: '', ...overrides.files },
    rateLimit: {
      globalPerMinute: 10_000,
      authPerMinute: 10_000,
      serverCreatePerHour: 10_000,
      friendRequestsPerMinute: 10_000,
      inviteJoinsPerMinute: 10_000,
      reportsPerHour: 10_000,
      ...overrides.rateLimit,
    },
  };
  const db = await createDb({ databaseUrl: '', pgliteDir: '' }); // PGlite em memória
  await migrate(db);
  const app = await buildApp(config, db);
  app.addHook('onClose', async () => db.close());
  return app;
}

let counter = 0;
export const uniqueName = (prefix = 'user') => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export const PASSWORD = 'senha-muito-segura-1';

export async function register(app: FastifyInstance, username = uniqueName(), password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username, password, clientName: 'teste' } });
  if (res.statusCode !== 201) throw new Error(`register falhou: ${res.statusCode} ${res.body}`);
  return res.json<RegisterResponse>();
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Cliente HTTP de teste autenticado: `const a = await user(app); await a.post('/servers', {...})`. */
export async function user(app: FastifyInstance, username = uniqueName()) {
  const reg = await register(app, username);
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: bearer(reg.token), payload: payload as object });
    const body = res.body ? (() => { try { return res.json(); } catch { return res.body; } })() : undefined;
    return { status: res.statusCode, body };
  };
  return {
    ...reg,
    id: reg.user.id,
    username: reg.user.username,
    discriminator: reg.user.discriminator,
    tag: `${reg.user.username}#${reg.user.discriminator}`,
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body ?? {}),
    put: (url: string, body?: unknown) => call('PUT', url, body ?? {}),
    patch: (url: string, body?: unknown) => call('PATCH', url, body),
    del: (url: string) => call('DELETE', url),
  };
}
export type TestUser = Awaited<ReturnType<typeof user>>;

/** Torna dois usuários amigos. */
export async function befriend(a: TestUser, b: TestUser) {
  await a.post('/users/@me/relationships', { username: b.tag });
  await b.put(`/users/@me/relationships/${a.id}`);
}
