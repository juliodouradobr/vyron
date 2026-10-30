import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().optional().default(''),
  PGLITE_DIR: z.string().optional().default('.data/pglite'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  CORS_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173,tauri://localhost,http://tauri.localhost'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** STUN públicos (separados por vírgula). Vazio = só candidatos locais (funciona em LAN). */
  STUN_URLS: z.string().default(''),
  /** TURN (coturn com `use-auth-secret`). Sem eles, "Ocultar meu IP" fica indisponível. */
  TURN_URLS: z.string().default(''),
  TURN_SECRET: z.string().default(''),
  /** Onde os arquivos enviados ficam no disco (anexos, avatares). Vazio = memória (só testes). */
  FILES_DIR: z.string().default('.data/files'),
});

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export interface Config {
  databaseUrl: string;
  pgliteDir: string;
  host: string;
  port: number;
  corsOrigins: string[];
  trustProxy: boolean;
  logLevel: string;
  auth: {
    sessionTtlMs: number;
    /** Só regrava last_used_at/expires_at quando passou este intervalo — evita uma escrita por requisição. */
    sessionTouchIntervalMs: number;
    maxFailedLogins: number;
    lockoutMs: number;
  };
  gateway: {
    heartbeatIntervalMs: number;
    identifyTimeoutMs: number;
    maxConnectionsPerUser: number;
    /** Tempo sem conexões antes de anunciar o usuário como offline (absorve reconexões rápidas). */
    offlineGraceMs: number;
  };
  voice: {
    stunUrls: string[];
    turnUrls: string[];
    turnSecret: string;
    /** Validade das credenciais TURN emitidas a cada entrada em voz. */
    turnTtlSeconds: number;
  };
  files: {
    /** Diretório no disco; '' guarda em memória (testes). */
    dir: string;
    maxAttachmentBytes: number;
    /** Avatar e banner. */
    maxImageBytes: number;
    maxAttachmentsPerMessage: number;
    /** Anexos enviados e ainda não usados em mensagem são apagados depois disso. */
    pendingTtlMs: number;
    uploadsPerMinute: number;
  };
  rateLimit: {
    globalPerMinute: number;
    authPerMinute: number;
    serverCreatePerHour: number;
    friendRequestsPerMinute: number;
    inviteJoinsPerMinute: number;
    reportsPerHour: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const e = envSchema.parse(env);
  const base: Config = {
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    host: e.HOST,
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    auth: {
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      sessionTouchIntervalMs: 60 * 60 * 1000,
      maxFailedLogins: 5,
      lockoutMs: 15 * 60 * 1000,
    },
    gateway: {
      heartbeatIntervalMs: 30_000,
      identifyTimeoutMs: 10_000,
      maxConnectionsPerUser: 10,
      offlineGraceMs: 5_000,
    },
    voice: {
      stunUrls: list(e.STUN_URLS),
      turnUrls: list(e.TURN_URLS),
      turnSecret: e.TURN_SECRET,
      turnTtlSeconds: 6 * 60 * 60,
    },
    files: {
      dir: e.FILES_DIR,
      maxAttachmentBytes: 10 * 1024 * 1024,
      maxImageBytes: 4 * 1024 * 1024,
      maxAttachmentsPerMessage: 10,
      pendingTtlMs: 60 * 60 * 1000,
      uploadsPerMinute: 30,
    },
    rateLimit: {
      globalPerMinute: 300,
      authPerMinute: 10,
      serverCreatePerHour: 10,
      friendRequestsPerMinute: 20,
      inviteJoinsPerMinute: 20,
      reportsPerHour: 10,
    },
  };
  return { ...base, ...overrides };
}
