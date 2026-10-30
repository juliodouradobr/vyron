import { z } from 'zod';

/**
 * Nome da parte "Name" do identificador Name#00000: letras (com acento), números, "_", "." e "-".
 * Maiúsculas são preservadas na exibição e ignoradas na comparação. Sem espaços, "#" ou "@".
 */
export const USERNAME_RE = /^[\p{L}\p{N}_.-]+$/u;

export const usernameSchema = z
  .string()
  .trim()
  // NFC: "é" digitado de formas diferentes vira o mesmo nome.
  .transform((v) => v.normalize('NFC'))
  .pipe(
    z
      .string()
      .min(2, 'O nome precisa ter ao menos 2 caracteres.')
      .max(32, 'O nome pode ter no máximo 32 caracteres.')
      .regex(USERNAME_RE, 'Use letras, números, "_", "." ou "-" (sem espaços).'),
  );

/** Discriminador: 5 dígitos, de 00001 a 99999. */
export const DISCRIMINATOR_RE = /^(?!00000)\d{5}$/;

export const formatTag = (u: { username: string; discriminator: string }) => `${u.username}#${u.discriminator}`;

/**
 * Interpreta o que a pessoa digitou para identificar alguém: "Nome#12345" (completo) ou só "Nome"
 * (aceito pelo servidor apenas quando existir uma única conta com esse nome).
 */
export function parseTag(input: string): { name: string; discriminator: string | null } | null {
  const v = input.trim().replace(/^@/, '').normalize('NFC');
  const m = /^(.+?)#(\d{5})$/.exec(v);
  const name = m ? m[1]! : v;
  if (name.length < 2 || name.length > 32 || !USERNAME_RE.test(name)) return null;
  if (m && !DISCRIMINATOR_RE.test(m[2]!)) return null;
  return { name, discriminator: m ? m[2]! : null };
}

/** Campo de identificação (login, recuperação, pedido de amizade): "Nome#00000" ou "Nome". */
export const userIdentifierSchema = z
  .string()
  .trim()
  .max(40)
  .refine((v) => parseTag(v) !== null, 'Informe o identificador no formato Nome#00000.');

// Limite superior evita que senhas enormes sejam usadas para consumir CPU no hash.
export const passwordSchema = z
  .string()
  .min(8, 'A senha precisa ter ao menos 8 caracteres.')
  .max(128, 'A senha pode ter no máximo 128 caracteres.');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Informe um nome de exibição.')
  .max(32, 'O nome de exibição pode ter no máximo 32 caracteres.')
  // Bloqueia caracteres de controle e de direção de texto usados para enganar a leitura de nomes.
  .refine((v) => !/[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(v), 'Caracteres inválidos.');

export const presenceStatusSchema = z.enum(['online', 'idle', 'dnd', 'invisible']);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

export const clientNameSchema = z.string().trim().max(64).optional();

export const registerSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema.optional(),
    password: passwordSchema,
    clientName: clientNameSchema,
  })
  .refine((v) => v.password.toLowerCase() !== v.username.toLowerCase(), {
    message: 'A senha não pode ser igual ao nome.',
    path: ['password'],
  });
export type RegisterInput = z.input<typeof registerSchema>;

/** `username` aqui é o identificador: "Nome#00000" (ou só o nome, se for único). */
export const loginSchema = z.object({
  username: userIdentifierSchema,
  password: z.string().min(1).max(128),
  clientName: clientNameSchema,
});
export type LoginInput = z.input<typeof loginSchema>;

export const recoverySchema = z.object({
  username: userIdentifierSchema,
  recoveryCode: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().length(10, 'Código de recuperação inválido.')),
  newPassword: passwordSchema,
  clientName: clientNameSchema,
});
export type RecoveryInput = z.input<typeof recoverySchema>;

export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    bio: z.string().trim().max(190, 'A descrição pode ter no máximo 190 caracteres.').optional(),
    status: presenceStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');
export type UpdateProfileInput = z.input<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

export const regenerateRecoveryCodesSchema = z.object({
  password: z.string().min(1).max(128),
});

export const notifyLevelSchema = z.enum(['all', 'mentions', 'none']);
export type NotifyLevel = z.infer<typeof notifyLevelSchema>;
const muteUntilSchema = z.union([z.literal('always'), z.string().datetime()]);

/** Mapa por id (servidor/canal) com tamanho limitado: as preferências não podem crescer sem fim. */
function boundedRecord<T extends z.ZodTypeAny>(value: T) {
  return z.record(z.string().uuid(), value).refine((r) => Object.keys(r).length <= 200, 'Ajustes demais.');
}

/**
 * Preferências sincronizadas com a conta. Campos desconhecidos são descartados e cada
 * campo tem padrão, então clientes antigos e novos convivem sem quebrar.
 */
export const userSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  uiScale: z.number().min(0.8).max(1.5).default(1),
  reducedMotion: z.boolean().default(false),
  highContrast: z.boolean().default(false),
  lowPowerMode: z.boolean().default(false),
  showMessagePreviewInNotifications: z.boolean().default(true),
  closeToTray: z.boolean().default(true),
  /** Privacidade: quem pode enviar pedido de amizade. */
  friendRequestsFrom: z.enum(['everyone', 'server_members', 'nobody']).default('everyone'),
  /** Privacidade: aceitar mensagens diretas de quem não é amigo mas está em um servidor em comum. */
  allowDmsFromServerMembers: z.boolean().default(true),

  /* ---- Voz (Etapa 3) ---- */
  inputDeviceId: z.string().max(256).default('default'),
  outputDeviceId: z.string().max(256).default('default'),
  /** 0–2 (1 = sem alteração). */
  inputVolume: z.number().min(0).max(2).default(1),
  outputVolume: z.number().min(0).max(2).default(1),
  inputMode: z.enum(['voice_activity', 'push_to_talk']).default('voice_activity'),
  /** Limiar de ativação por voz em dBFS (-100 = sempre aberto). */
  vadThresholdDb: z.number().min(-100).max(0).default(-50),
  /**
   * Tecla do push-to-talk (KeyboardEvent.code). Funciona com o app em foco e fora de campos de texto;
   * o atalho global do Windows chega com o núcleo nativo.
   */
  pushToTalkKey: z.string().max(32).default('Backquote'),
  echoCancellation: z.boolean().default(true),
  autoGainControl: z.boolean().default(true),
  /** Obsoleto desde a Etapa 4: a supressão clássica agora é derivada de `noiseMode`. Mantido por compatibilidade. */
  noiseSuppression: z.boolean().default(true),
  /**
   * Supressão de ruído (Etapa 4). auto/strong/balanced/light/natural usam a rede neural local;
   * economy usa só a supressão clássica do WebRTC; off não aplica supressão adicional.
   */
  noiseMode: z.enum(['auto', 'strong', 'balanced', 'light', 'natural', 'economy', 'off']).default('auto'),
  /** Força relay TURN: participantes não veem seu IP. Exige TURN configurado no servidor. */
  voiceRelayOnly: z.boolean().default(false),
  /** Volume por pessoa (0–2), indexado pelo id do usuário. */
  userVolumes: z.record(z.string().uuid(), z.number().min(0).max(2)).default({}),

  /* ---- Notificações ---- */
  /** Notificações do sistema (fora do app). Desligado, só os indicadores dentro do app continuam. */
  notifyDesktop: z.boolean().default(true),
  notifySounds: z.boolean().default(true),
  notifyDms: z.boolean().default(true),
  notifyMentions: z.boolean().default(true),
  notifyFriendRequests: z.boolean().default(true),
  /** Padrão para mensagens de servidores: só quando me mencionam, todas ou nenhuma. */
  notifyServerDefault: notifyLevelSchema.default('mentions'),
  /** Ajuste por servidor (sobrepõe o padrão). */
  serverNotify: boundedRecord(notifyLevelSchema).default({}),
  /** Silenciados até a data (ISO) ou para sempre ('always'), por servidor e por canal. */
  mutedServers: boundedRecord(muteUntilSchema).default({}),
  mutedChannels: boundedRecord(muteUntilSchema).default({}),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;
export const DEFAULT_SETTINGS: UserSettings = userSettingsSchema.parse({});
