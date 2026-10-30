/** Códigos de erro estáveis da API. O cliente traduz cada um em uma mensagem de interface. */
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  UNKNOWN_ACCOUNT: 'UNKNOWN_ACCOUNT',
  /** Só o nome foi informado e há mais de uma conta com ele: é preciso o identificador completo Nome#00000. */
  AMBIGUOUS_USERNAME: 'AMBIGUOUS_USERNAME',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_RECOVERY_CODE: 'INVALID_RECOVERY_CODE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE: 'UNSUPPORTED_FILE',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    /** Segundos até poder tentar de novo (RATE_LIMITED / ACCOUNT_LOCKED). */
    retryAfter?: number;
  };
}
