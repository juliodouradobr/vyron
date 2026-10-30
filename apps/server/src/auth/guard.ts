import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../http/errors';
import type { AuthContext } from './service';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

/** preHandler que exige um token Bearer válido. A identidade vem sempre do token, nunca do corpo. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  const match = header && /^Bearer (\S+)$/.exec(header);
  if (!match) throw unauthorized();
  req.authContext = await req.server.auth.authenticate(match[1]!);
}

export function authOf(req: FastifyRequest): AuthContext {
  if (!req.authContext) throw unauthorized();
  return req.authContext;
}
