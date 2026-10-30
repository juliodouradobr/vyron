import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './index';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Aplica, em ordem, os arquivos NNN_nome.sql ainda não registrados em schema_migrations.
 * Cada migração roda em sua própria transação; uma falha interrompe sem marcar como aplicada.
 */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
    } catch (err) {
      throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
    }
    log(`migração aplicada: ${file}`);
    done.push(file);
  }
  return done;
}
