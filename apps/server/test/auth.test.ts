import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LoginSession } from '@nexo/protocol';
import { PASSWORD, bearer, createTestApp, register, uniqueName } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const post = (url: string, payload: unknown, headers = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers });
const login = (username: string, password = PASSWORD) => post('/api/v1/auth/login', { username, password, clientName: 'teste' });

describe('cadastro', () => {
  it('cria conta, devolve token e 10 códigos de recuperação sem vazar dados internos', async () => {
    const username = uniqueName();
    const res = await post('/api/v1/auth/register', { username, password: PASSWORD, displayName: 'Jogador' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ username, displayName: 'Jogador', status: 'online' });
    expect(body.user.discriminator).toMatch(/^(?!00000)\d{5}$/);
    expect(body.token).toMatch(/^nx_/);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(JSON.stringify(body)).not.toMatch(/password|hash|argon/i);
  });

  it('guarda a senha com Argon2id e o token apenas como hash', async () => {
    const r = await register(app);
    const { rows } = await app.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [r.user.id]);
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    const { rows: s } = await app.db.query<{ token_hash: string }>('SELECT token_hash FROM login_sessions WHERE user_id = $1', [r.user.id]);
    expect(s[0]!.token_hash).not.toContain(r.token);
    expect(s[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('permite nomes repetidos com discriminadores diferentes e preserva maiúsculas', async () => {
    const username = uniqueName('Gamer');
    const a = await register(app, username);
    const b = await register(app, username.toUpperCase());
    expect(a.user.username).toBe(username);
    expect(b.user.username).toBe(username.toUpperCase());
    expect(a.user.discriminator).not.toBe(b.user.discriminator);
  });

  it('aceita nomes com acento e recusa "#", "@" e espaços', async () => {
    const r = await register(app, `Joãozinho_${Date.now().toString(36).slice(-4)}`);
    expect(r.user.username).toMatch(/^Joãozinho_/);
    for (const username of ['nome#1', '@nome', 'com espaço']) {
      expect((await post('/api/v1/auth/register', { username, password: PASSWORD })).statusCode).toBe(400);
    }
  });

  it('a constraint do banco impede o mesmo nome + discriminador, sem diferenciar maiúsculas', async () => {
    const { user } = await register(app);
    await expect(
      app.db.query(`INSERT INTO users (id, username, discriminator, display_name, password_hash) VALUES (gen_random_uuid(), $1, $2, 'x', 'x')`, [
        user.username.toUpperCase(),
        user.discriminator,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('valida a entrada', async () => {
    const res = await post('/api/v1/auth/register', { username: 'a b', password: '123' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('recusa corpo malformado', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: '{nao-json', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('login', () => {
  it('entra com o identificador completo ou só com o nome, quando ele é único', async () => {
    const { user } = await register(app);
    const full = await login(`${user.username.toUpperCase()}#${user.discriminator}`);
    expect(full.statusCode).toBe(200);
    expect(full.json().user.id).toBe(user.id);
    expect((await login(user.username)).json().user.id).toBe(user.id);
  });

  it('com nome repetido, exige o identificador completo e entra na conta certa', async () => {
    const username = uniqueName();
    const a = await register(app, username, 'senha-da-conta-a');
    const b = await register(app, username, 'senha-da-conta-b');
    const bare = await login(username, 'senha-da-conta-a');
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error.code).toBe('AMBIGUOUS_USERNAME');
    expect((await login(`${username}#${b.user.discriminator}`, 'senha-da-conta-b')).json().user.id).toBe(b.user.id);
    // Senha de A no identificador de B não entra em nenhuma das duas.
    expect((await login(`${username}#${b.user.discriminator}`, 'senha-da-conta-a')).statusCode).toBe(401);
    expect((await login(`${username}#${a.user.discriminator}`, 'senha-da-conta-a')).json().user.id).toBe(a.user.id);
  });

  it('distingue conta inexistente de senha incorreta', async () => {
    expect((await login('nao_existe_xyz')).json().error.code).toBe('UNKNOWN_ACCOUNT');
    const { user } = await register(app);
    const res = await login(user.username, 'errada-123456');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('bloqueia a conta após 5 falhas, mesmo com a senha certa depois', async () => {
    const { user } = await register(app);
    for (let i = 0; i < 4; i++) expect((await login(user.username, 'errada-123456')).statusCode).toBe(401);
    const fifth = await login(user.username, 'errada-123456');
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.headers['retry-after']).toBeDefined();
    expect((await login(user.username)).json().error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('sessões', () => {
  it('exige token válido', async () => {
    expect((await app.inject({ url: '/api/v1/users/@me' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer('nx_falso') })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
  });

  it('logout invalida o token imediatamente', async () => {
    const { token } = await register(app);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(token) })).statusCode).toBe(200);
    expect((await post('/api/v1/auth/logout', undefined, bearer(token))).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('informa sessão expirada', async () => {
    const { token, user } = await register(app);
    await app.db.query(`UPDATE login_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);
    const res = await app.inject({ url: '/api/v1/users/@me', headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('lista e revoga sessões próprias, mas não de outro usuário', async () => {
    const a = await register(app);
    const second = (await login(a.user.username)).json();
    const list = (await app.inject({ url: '/api/v1/users/@me/sessions', headers: bearer(a.token) })).json<LoginSession[]>();
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);

    const other = list.find((s) => !s.current)!;
    const b = await register(app);
    const forged = await app.inject({ method: 'DELETE', url: `/api/v1/users/@me/sessions/${other.id}`, headers: bearer(b.token) });
    expect(forged.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(second.token) })).statusCode).toBe(200);

    const ok = await app.inject({ method: 'DELETE', url: `/api/v1/users/@me/sessions/${other.id}`, headers: bearer(a.token) });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(second.token) })).statusCode).toBe(401);
  });

  it('encerra todas as outras sessões', async () => {
    const a = await register(app);
    const s2 = (await login(a.user.username)).json();
    const s3 = (await login(a.user.username)).json();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/users/@me/sessions', headers: bearer(a.token) });
    expect(res.json()).toEqual({ revoked: 2 });
    for (const t of [s2.token, s3.token]) expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(t) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(a.token) })).statusCode).toBe(200);
  });
});

describe('senha e recuperação', () => {
  it('troca a senha, encerra as outras sessões e mantém a atual', async () => {
    const a = await register(app);
    const other = (await login(a.user.username)).json();
    const wrong = await post('/api/v1/users/@me/password', { currentPassword: 'errada-123', newPassword: 'nova-senha-123' }, bearer(a.token));
    expect(wrong.statusCode).toBe(401);
    const ok = await post('/api/v1/users/@me/password', { currentPassword: PASSWORD, newPassword: 'nova-senha-123' }, bearer(a.token));
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(a.token) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(other.token) })).statusCode).toBe(401);
    expect((await login(a.user.username)).statusCode).toBe(401);
    expect((await login(a.user.username, 'nova-senha-123')).statusCode).toBe(200);
  });

  it('recupera o acesso com código de uso único e derruba sessões antigas', async () => {
    const a = await register(app);
    const code = a.recoveryCodes[3]!;
    const bad = await post('/api/v1/auth/recover', { username: a.user.username, recoveryCode: 'AAAAA-AAAAA', newPassword: 'recuperada-1' });
    expect(bad.json().error.code).toBe('INVALID_RECOVERY_CODE');

    const ok = await post('/api/v1/auth/recover', { username: a.user.username, recoveryCode: code.toLowerCase(), newPassword: 'recuperada-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toMatch(/^nx_/);
    expect((await app.inject({ url: '/api/v1/users/@me', headers: bearer(a.token) })).statusCode).toBe(401);
    expect((await login(a.user.username, 'recuperada-1')).statusCode).toBe(200);

    const reuse = await post('/api/v1/auth/recover', { username: a.user.username, recoveryCode: code, newPassword: 'outra-senha-1' });
    expect(reuse.json().error.code).toBe('INVALID_RECOVERY_CODE');
  });

  it('gera novos códigos e invalida os anteriores', async () => {
    const a = await register(app);
    const res = await post('/api/v1/users/@me/recovery-codes', { password: PASSWORD }, bearer(a.token));
    expect(res.json().recoveryCodes).toHaveLength(10);
    const old = await post('/api/v1/auth/recover', { username: a.user.username, recoveryCode: a.recoveryCodes[0], newPassword: 'outra-senha-1' });
    expect(old.json().error.code).toBe('INVALID_RECOVERY_CODE');
  });
});

describe('perfil e preferências', () => {
  it('atualiza o perfil e ignora campos que o cliente não pode definir', async () => {
    const a = await register(app);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/@me',
      headers: bearer(a.token),
      payload: { displayName: 'Novo Nome', bio: 'oi', status: 'dnd', username: 'admin', id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.user.id, username: a.user.username, displayName: 'Novo Nome', bio: 'oi', status: 'dnd' });
  });

  it('salva e recupera preferências com padrões e validação', async () => {
    const a = await register(app);
    const get = await app.inject({ url: '/api/v1/users/@me/settings', headers: bearer(a.token) });
    expect(get.json().settings).toEqual(DEFAULT_SETTINGS);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/users/@me/settings',
      headers: bearer(a.token),
      payload: { theme: 'light', uiScale: 1.25, injected: '<script>' },
    });
    expect(put.statusCode).toBe(200);
    const again = (await app.inject({ url: '/api/v1/users/@me/settings', headers: bearer(a.token) })).json();
    expect(again.settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', uiScale: 1.25 });

    const bad = await app.inject({ method: 'PUT', url: '/api/v1/users/@me/settings', headers: bearer(a.token), payload: { uiScale: 9 } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('proteções HTTP', () => {
  it('aplica limite de requisições nas rotas de autenticação', async () => {
    const limited = await createTestApp({ rateLimit: { authPerMinute: 3 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await limited.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'x_y', password: 'abcdefgh' } });
        codes.push(r.statusCode);
        if (r.statusCode === 429) expect(r.json().error.code).toBe('RATE_LIMITED');
      }
      expect(codes).toEqual([404, 404, 404, 429]);
    } finally {
      await limited.close();
    }
  });

  it('envia cabeçalhos de segurança e bloqueia origens não autorizadas', async () => {
    const res = await app.inject({ url: '/api/v1/health', headers: { origin: 'https://site-malicioso.example' } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await app.inject({ url: '/api/v1/health', headers: { origin: 'tauri://localhost' } });
    expect(ok.headers['access-control-allow-origin']).toBe('tauri://localhost');
  });

  it('aceita o preflight do servidor de desenvolvimento do Vite', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/register',
      headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });
});
