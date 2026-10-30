import { loadConfig } from '../config';
import { createDb } from './index';
import { migrate } from './migrate';

const config = loadConfig();
const db = await createDb(config);
const applied = await migrate(db, console.log);
console.log(applied.length ? `${applied.length} migração(ões) aplicada(s).` : 'Banco já está atualizado.');
await db.close();
