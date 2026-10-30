import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Executable extends Queryable {
  /** Executa várias instruções sem parâmetros (usado por migrações). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Executable {
  transaction<T>(fn: (tx: Executable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'postgres' | 'pglite';
}

/** PostgreSQL real via node-postgres (produção). */
function createPostgres(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return {
    driver: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<T>(sql: string, params: unknown[] = []) {
            const r = await client.query(sql, params);
            return { rows: r.rows as T[] };
          },
          async exec(sql) {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** PostgreSQL embutido (WASM) para desenvolvimento e testes. `dir` vazio = em memória. */
async function createPglite(dir: string): Promise<Db> {
  // O PGlite cria apenas o último nível do caminho.
  if (dir) await mkdir(path.dirname(path.resolve(dir)), { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  return {
    driver: 'pglite',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await db.query<T>(sql, params);
      return { rows: r.rows };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          async query<T>(sql: string, params: unknown[] = []) {
            const r = await tx.query<T>(sql, params);
            return { rows: r.rows };
          },
          async exec(sql) {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => db.close(),
  };
}

export async function createDb(opts: { databaseUrl: string; pgliteDir: string }): Promise<Db> {
  if (opts.databaseUrl) return createPostgres(opts.databaseUrl);
  return createPglite(opts.pgliteDir);
}
