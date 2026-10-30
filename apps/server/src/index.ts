import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './db/migrate';

const config = loadConfig();
const db = await createDb(config);
await migrate(db, (m) => console.log(m));

const app = await buildApp(config, db);

const shutdown = async (signal: string) => {
  app.log.info(`recebido ${signal}, encerrando`);
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
if (!config.databaseUrl) app.log.warn(`usando PGlite em ${config.pgliteDir} — apenas para desenvolvimento`);
