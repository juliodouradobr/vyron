import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ErrorCode, type ApiErrorBody } from '@nexo/protocol';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: { details?: unknown; retryAfter?: number } = {},
  ) {
    super(message);
  }
}

export const unauthorized = (msg = 'Autenticação necessária.') => new AppError(401, ErrorCode.UNAUTHORIZED, msg);
export const forbidden = (msg = 'Você não tem permissão para isso.') => new AppError(403, ErrorCode.FORBIDDEN, msg);
export const notFound = (msg = 'Não encontrado.') => new AppError(404, ErrorCode.NOT_FOUND, msg);

export function parseBody<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw validationError(r.error);
  return r.data;
}

function validationError(err: ZodError): AppError {
  const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return new AppError(400, ErrorCode.VALIDATION, details[0]?.message ?? 'Dados inválidos.', { details });
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err instanceof ZodError) e = validationError(err);
    else if ((err as FastifyError).validation || (err as FastifyError).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
      e = new AppError(400, ErrorCode.VALIDATION, 'Requisição inválida.');
    else if ((err as FastifyError).statusCode === 413) e = new AppError(413, ErrorCode.FILE_TOO_LARGE, 'Conteúdo grande demais para esta operação.');
    else if ((err as FastifyError).statusCode === 400) e = new AppError(400, ErrorCode.VALIDATION, 'Requisição malformada.');
    else {
      req.log.error({ err }, 'erro não tratado');
      e = new AppError(500, ErrorCode.INTERNAL, 'Erro interno do servidor.');
    }
    if (e.extra.retryAfter) reply.header('retry-after', String(e.extra.retryAfter));
    const body: ApiErrorBody = { error: { code: e.code, message: e.message, ...e.extra } };
    return reply.status(e.statusCode).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    const body: ApiErrorBody = { error: { code: ErrorCode.NOT_FOUND, message: 'Rota não encontrada.' } };
    return reply.status(404).send(body);
  });
}
