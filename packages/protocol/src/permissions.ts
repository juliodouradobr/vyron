/**
 * Permissões como bitfield. Valores são persistidos — nunca renumere um bit existente.
 *
 * Ordem de resolução (determinística, documentada em docs/ARCHITECTURE.md):
 *  1. Proprietário do servidor → todas as permissões.
 *  2. base = permissões de @everyone OR permissões de cada cargo do membro.
 *  3. Se base contém ADMINISTRATOR → todas as permissões (overwrites ignorados).
 *  4. Overwrite de canal para @everyone: remove deny, depois adiciona allow.
 *  5. Overwrites dos cargos do membro: une todos os deny e todos os allow; remove deny, adiciona allow.
 *  6. Overwrite específico do membro: remove deny, adiciona allow (mais específico vence).
 *  7. Sem VIEW_CHANNEL no canal → nenhuma permissão nele.
 */
export const Permission = {
  ADMINISTRATOR: 1n << 0n,
  MANAGE_SERVER: 1n << 1n,
  MANAGE_CHANNELS: 1n << 2n,
  MANAGE_ROLES: 1n << 3n,
  MANAGE_MESSAGES: 1n << 4n,
  KICK_MEMBERS: 1n << 5n,
  BAN_MEMBERS: 1n << 6n,
  MANAGE_INVITES: 1n << 7n,
  CREATE_INVITES: 1n << 8n,
  VIEW_CHANNEL: 1n << 9n,
  SEND_MESSAGES: 1n << 10n,
  ATTACH_FILES: 1n << 11n,
  ADD_REACTIONS: 1n << 12n,
  MENTION_EVERYONE: 1n << 13n,
  CONNECT_VOICE: 1n << 14n,
  SPEAK: 1n << 15n,
  STREAM: 1n << 16n,
  MUTE_MEMBERS: 1n << 17n,
  MOVE_MEMBERS: 1n << 18n,
  MANAGE_EVENTS: 1n << 19n,
  VIEW_AUDIT_LOG: 1n << 20n,
  /** Ligar a câmera em canais de voz (separada de STREAM: dá para permitir tela sem câmera e vice-versa). */
  VIDEO: 1n << 21n,
} as const;
export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS: bigint = Object.values(Permission).reduce((a, b) => a | b, 0n);

export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS |
  Permission.CREATE_INVITES |
  Permission.CONNECT_VOICE |
  Permission.SPEAK |
  Permission.STREAM |
  Permission.VIDEO;

export interface Overwrite {
  allow: bigint;
  deny: bigint;
}

export interface PermissionContext {
  isOwner: boolean;
  everyone: bigint;
  memberRoles: bigint[];
  channel?: {
    everyone?: Overwrite;
    roles: Overwrite[];
    member?: Overwrite;
  };
}

export function computePermissions(ctx: PermissionContext): bigint {
  if (ctx.isOwner) return ALL_PERMISSIONS;

  let perms = ctx.memberRoles.reduce((acc, r) => acc | r, ctx.everyone);
  if (perms & Permission.ADMINISTRATOR) return ALL_PERMISSIONS;
  if (!ctx.channel) return perms;

  const { everyone, roles, member } = ctx.channel;
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of roles) {
    roleAllow |= o.allow;
    roleDeny |= o.deny;
  }
  perms = (perms & ~roleDeny) | roleAllow;

  if (member) perms = (perms & ~member.deny) | member.allow;

  if (!(perms & Permission.VIEW_CHANNEL)) return 0n;
  return perms;
}

export function hasPermission(perms: bigint, required: bigint): boolean {
  if (perms & Permission.ADMINISTRATOR) return true;
  return (perms & required) === required;
}

/**
 * Um usuário só pode conceder (a um cargo ou overwrite) permissões que ele mesmo possui.
 * Impede escalonamento por requisições forjadas.
 */
export function canGrant(actorPerms: bigint, requested: bigint): boolean {
  if (actorPerms & Permission.ADMINISTRATOR) return true;
  return (requested & ~actorPerms) === 0n;
}

/** Bitfields trafegam como string decimal no JSON (BigInt não é serializável). */
export const serializePermissions = (p: bigint): string => p.toString();
export const parsePermissions = (s: string): bigint => {
  if (!/^\d{1,20}$/.test(s)) throw new Error('bitfield de permissão inválido');
  return BigInt(s) & ALL_PERMISSIONS;
};
