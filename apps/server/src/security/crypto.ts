import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// Parâmetros mínimos recomendados pela OWASP para Argon2id (o algoritmo padrão da biblioteca).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Token de sessão opaco: 256 bits aleatórios. O prefixo facilita detectar vazamentos em logs/scanners. */
export const generateSessionToken = (): string => `nx_${randomBytes(32).toString('base64url')}`;

/** Tokens têm entropia alta, então SHA-256 basta (não há o que adivinhar por força bruta). */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// Sem 0/O e 1/I para evitar confusão ao digitar.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Código de recuperação no formato XXXXX-XXXXX (~50 bits). Guardado com Argon2id. */
export function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export const normalizeRecoveryCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
