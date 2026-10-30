import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type AuthResponse,
  type LoginSession,
  type RegisterResponse,
  type SelfUser,
  type loginSchema,
  type recoverySchema,
  type registerSchema,
} from '@nexo/protocol';
import type { z } from 'zod';
import type { Config } from '../config';
import type { Db, Queryable } from '../db';
import { AppError } from '../http/errors';
import {
  generateRecoveryCode,
  generateSessionToken,
  hashPassword,
  hashToken,
  normalizeRecoveryCode,
  verifyPassword,
} from '../security/crypto';
import { findUserById, findUserByTag, pickDiscriminator, toSelfUser, type UserRow } from '../users/repo';

const RECOVERY_CODE_COUNT = 10;

export interface AuthContext {
  user: SelfUser;
  sessionId: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  client_name: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Regras de autenticação. Não conhece HTTP: lança AppError com códigos estáveis e devolve
 * os IDs de sessões revogadas para que o gateway derrube as conexões correspondentes.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  private async createSession(q: Queryable, userId: string, clientName = ''): Promise<{ token: string; expiresAt: string; sessionId: string }> {
    const token = generateSessionToken();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.auth.sessionTtlMs);
    await q.query(
      `INSERT INTO login_sessions (id, user_id, token_hash, client_name, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, userId, hashToken(token), clientName.slice(0, 64), expiresAt],
    );
    return { token, sessionId, expiresAt: expiresAt.toISOString() };
  }

  private async replaceRecoveryCodes(q: Queryable, userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => hashPassword(normalizeRecoveryCode(c))));
    await q.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const h of hashes) {
      await q.query('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)', [randomUUID(), userId, h]);
    }
    return codes;
  }

  async register(input: z.output<typeof registerSchema>): Promise<RegisterResponse> {
    // Hash calculado fora da transação para não segurar a conexão durante o trabalho de CPU.
    const passwordHash = await hashPassword(input.password);
    // O nome pode se repetir; o par nome + discriminador, não. Em uma corrida rara pelo mesmo número,
    // a constraint única recusa e sorteamos outro.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const discriminator = await pickDiscriminator(tx, input.username);
          if (!discriminator) throw usernameTaken();
          const id = randomUUID();
          const { rows } = await tx.query<UserRow>(
            `INSERT INTO users (id, username, discriminator, display_name, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [id, input.username, discriminator, input.displayName ?? input.username, passwordHash],
          );
          await tx.query('INSERT INTO user_settings (user_id) VALUES ($1)', [id]);
          const recoveryCodes = await this.replaceRecoveryCodes(tx, id);
          const session = await this.createSession(tx, id, input.clientName);
          return { user: toSelfUser(rows[0]!), token: session.token, expiresAt: session.expiresAt, recoveryCodes };
        });
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }
    throw usernameTaken();
  }

  /** Verifica bloqueio temporário da conta antes de qualquer checagem de segredo. */
  private assertNotLocked(user: UserRow): void {
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const retryAfter = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      throw new AppError(429, ErrorCode.ACCOUNT_LOCKED, 'Muitas tentativas. Aguarde antes de tentar novamente.', { retryAfter });
    }
  }

  /** Conta uma falha; ao atingir o limite, bloqueia a conta temporariamente e zera o contador. */
  private async registerFailure(user: UserRow): Promise<boolean> {
    const { rows } = await this.db.query<{ failed_logins: number }>(
      'UPDATE users SET failed_logins = failed_logins + 1 WHERE id = $1 RETURNING failed_logins',
      [user.id],
    );
    if ((rows[0]?.failed_logins ?? 0) >= this.config.auth.maxFailedLogins) {
      await this.db.query('UPDATE users SET failed_logins = 0, locked_until = $2 WHERE id = $1', [
        user.id,
        new Date(Date.now() + this.config.auth.lockoutMs),
      ]);
      return true;
    }
    return false;
  }

  async login(input: z.output<typeof loginSchema>): Promise<AuthResponse> {
    const user = await findUserByTag(this.db, input.username);
    if (!user) throw unknownAccount();
    this.assertNotLocked(user);

    if (!(await verifyPassword(user.password_hash, input.password))) {
      const locked = await this.registerFailure(user);
      if (locked) {
        throw new AppError(429, ErrorCode.ACCOUNT_LOCKED, 'Muitas tentativas. Conta bloqueada temporariamente.', {
          retryAfter: Math.ceil(this.config.auth.lockoutMs / 1000),
        });
      }
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Senha incorreta.');
    }

    await this.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
    const session = await this.createSession(this.db, user.id, input.clientName);
    return { user: toSelfUser(user), token: session.token, expiresAt: session.expiresAt };
  }

  async recover(input: z.output<typeof recoverySchema>): Promise<AuthResponse & { revokedSessionIds: string[] }> {
    const user = await findUserByTag(this.db, input.username);
    if (!user) throw unknownAccount();
    this.assertNotLocked(user);

    const { rows: codes } = await this.db.query<{ id: string; code_hash: string }>(
      'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [user.id],
    );
    let matchId: string | undefined;
    for (const c of codes) {
      if (await verifyPassword(c.code_hash, input.recoveryCode)) {
        matchId = c.id;
        break;
      }
    }
    if (!matchId) {
      await this.registerFailure(user);
      throw new AppError(401, ErrorCode.INVALID_RECOVERY_CODE, 'Código de recuperação inválido ou já utilizado.');
    }

    const passwordHash = await hashPassword(input.newPassword);
    return this.db.transaction(async (tx) => {
      // used_at IS NULL na condição impede reutilizar o mesmo código em requisições concorrentes.
      const { rows: used } = await tx.query('UPDATE recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [matchId]);
      if (used.length === 0) throw new AppError(401, ErrorCode.INVALID_RECOVERY_CODE, 'Código de recuperação inválido ou já utilizado.');
      await tx.query(
        'UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1',
        [user.id, passwordHash],
      );
      const { rows: revoked } = await tx.query<{ id: string }>(
        'UPDATE login_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
        [user.id],
      );
      const session = await this.createSession(tx, user.id, input.clientName);
      return {
        user: toSelfUser(user),
        token: session.token,
        expiresAt: session.expiresAt,
        revokedSessionIds: revoked.map((r) => r.id),
      };
    });
  }

  /** Resolve um token em usuário + sessão. Renova a expiração (deslizante) no máximo uma vez por intervalo. */
  async authenticate(token: string): Promise<AuthContext> {
    if (!token.startsWith('nx_') || token.length > 64) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Token inválido.');
    const { rows } = await this.db.query<SessionRow>('SELECT * FROM login_sessions WHERE token_hash = $1', [hashToken(token)]);
    const s = rows[0];
    if (!s || s.revoked_at) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Sessão inválida ou encerrada.');
    if (new Date(s.expires_at).getTime() <= Date.now()) throw new AppError(401, ErrorCode.SESSION_EXPIRED, 'Sua sessão expirou. Entre novamente.');

    const user = await findUserById(this.db, s.user_id);
    if (!user) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Sessão inválida.');

    if (Date.now() - new Date(s.last_used_at).getTime() > this.config.auth.sessionTouchIntervalMs) {
      await this.db.query('UPDATE login_sessions SET last_used_at = now(), expires_at = $2 WHERE id = $1', [
        s.id,
        new Date(Date.now() + this.config.auth.sessionTtlMs),
      ]);
    }
    return { user: toSelfUser(user), sessionId: s.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query('UPDATE login_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
  }

  async changePassword(ctx: AuthContext, currentPassword: string, newPassword: string): Promise<string[]> {
    const user = await findUserById(this.db, ctx.user.id);
    if (!user) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Sessão inválida.');
    this.assertNotLocked(user);
    if (!(await verifyPassword(user.password_hash, currentPassword))) {
      await this.registerFailure(user);
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'A senha atual está incorreta.');
    }
    const passwordHash = await hashPassword(newPassword);
    return this.db.transaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [user.id, passwordHash]);
      // Trocar a senha encerra todas as outras sessões — quem tinha a senha antiga perde o acesso.
      const { rows } = await tx.query<{ id: string }>(
        'UPDATE login_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id',
        [user.id, ctx.sessionId],
      );
      return rows.map((r) => r.id);
    });
  }

  async regenerateRecoveryCodes(ctx: AuthContext, password: string): Promise<string[]> {
    const user = await findUserById(this.db, ctx.user.id);
    if (!user) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Sessão inválida.');
    this.assertNotLocked(user);
    if (!(await verifyPassword(user.password_hash, password))) {
      await this.registerFailure(user);
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Senha incorreta.');
    }
    return this.db.transaction((tx) => this.replaceRecoveryCodes(tx, user.id));
  }

  async listSessions(ctx: AuthContext): Promise<LoginSession[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT * FROM login_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_used_at DESC`,
      [ctx.user.id],
    );
    return rows.map((s) => ({
      id: s.id,
      clientName: s.client_name || 'Dispositivo desconhecido',
      createdAt: new Date(s.created_at).toISOString(),
      lastUsedAt: new Date(s.last_used_at).toISOString(),
      expiresAt: new Date(s.expires_at).toISOString(),
      current: s.id === ctx.sessionId,
    }));
  }

  /** Revoga uma sessão do próprio usuário. A condição user_id impede revogar sessões alheias. */
  async revokeSession(ctx: AuthContext, sessionId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'UPDATE login_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [sessionId, ctx.user.id],
    );
    return rows.length > 0;
  }

  async revokeOtherSessions(ctx: AuthContext): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      'UPDATE login_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id',
      [ctx.user.id, ctx.sessionId],
    );
    return rows.map((r) => r.id);
  }
}

const usernameTaken = () =>
  new AppError(409, ErrorCode.USERNAME_TAKEN, 'Não há mais identificadores livres para esse nome. Escolha outro nome.');
const unknownAccount = () => new AppError(404, ErrorCode.UNKNOWN_ACCOUNT, 'Não existe conta com esse identificador.');
