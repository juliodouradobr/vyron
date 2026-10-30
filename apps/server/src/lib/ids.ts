import { randomBytes, randomInt } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48 bits de timestamp em ms + aleatoriedade. Ordenável por tempo, então serve
 * de cursor de paginação. Dentro do mesmo milissegundo, um contador de 12 bits mantém a ordem.
 */
export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1; // contador esgotou: avança 1 ms lógico
    now = lastMs;
  } else {
    lastMs = now;
    seq = randomInt(0, 0x800);
  }
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const INVITE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Código de convite de 10 caracteres (~58 bits): não adivinhável e curto para compartilhar. */
export function inviteCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return s;
}
