import { z } from 'zod';
import type { PublicUser } from './models';
import { userIdentifierSchema, type PresenceStatus } from './schemas';

/* ======================= Modelos ======================= */

export type RelationshipType = 'friend' | 'outgoing' | 'incoming' | 'blocked';
export type PublicPresence = PresenceStatus | 'offline';

export interface Relationship {
  user: PublicUser;
  type: RelationshipType;
  since: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
}

export interface Role {
  id: string;
  name: string;
  color: number | null;
  /** Bitfield em string decimal (BigInt não trafega em JSON). */
  permissions: string;
  position: number;
  isDefault: boolean;
}

export type ChannelType = 'category' | 'text' | 'voice' | 'announcement' | 'dm';

export interface ChannelOverwriteDto {
  targetType: 'role' | 'member';
  targetId: string;
  allow: string;
  deny: string;
}

export interface Channel {
  id: string;
  serverId: string | null;
  type: ChannelType;
  name: string;
  topic: string;
  parentId: string | null;
  position: number;
  lastMessageId: string | null;
  overwrites: ChannelOverwriteDto[];
  /** Permissões efetivas de quem pediu, neste canal. */
  myPermissions: string;
}

export interface DmChannel {
  id: string;
  type: 'dm';
  recipient: PublicUser;
  lastMessageId: string | null;
}

export interface ServerDetail {
  server: ServerSummary;
  roles: Role[];
  channels: Channel[];
  myPermissions: string;
  myRoleIds: string[];
  memberCount: number;
}

export interface Member {
  user: PublicUser;
  nickname: string | null;
  roleIds: string[];
  joinedAt: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  me: boolean;
}

export interface MessageReference {
  id: string;
  author: PublicUser | null;
  content: string;
}

/** Arquivo anexado. O conteúdo é baixado em /files/:id, com login e permissão de ver o canal. */
export interface Attachment {
  id: string;
  filename: string;
  /** Tipo detectado pelo servidor a partir do conteúdo (não pelo nome). */
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface Message {
  id: string;
  channelId: string;
  author: PublicUser;
  content: string;
  attachments: Attachment[];
  replyTo: MessageReference | null;
  mentions: string[];
  reactions: MessageReaction[];
  createdAt: string;
  editedAt: string | null;
  nonce: string | null;
}

export interface Invite {
  code: string;
  serverId: string;
  inviter: PublicUser | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface InvitePreview {
  code: string;
  server: { id: string; name: string; description: string };
  memberCount: number;
  expiresAt: string | null;
}

export interface ReadState {
  channelId: string;
  lastReadId: string | null;
}

export interface AuditEntry {
  id: string;
  actor: PublicUser | null;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/* ======================= Validação ======================= */

const uuid = z.string().uuid();
const bitfield = z.string().regex(/^\d{1,20}$/, 'Permissões inválidas.');

/** `username` é o identificador "Nome#00000" (ou só o nome, quando único). */
export const friendRequestSchema = z.object({
  username: userIdentifierSchema,
});

export const serverNameSchema = z.string().trim().min(2, 'O nome precisa ter ao menos 2 caracteres.').max(100);

export const createServerSchema = z.object({
  name: serverNameSchema,
  description: z.string().trim().max(300).optional(),
});

export const updateServerSchema = z
  .object({ name: serverNameSchema.optional(), description: z.string().trim().max(300).optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

export const channelNameSchema = z.string().trim().min(1, 'Informe um nome.').max(100);

export const createChannelSchema = z.object({
  name: channelNameSchema,
  type: z.enum(['category', 'text', 'voice', 'announcement']),
  parentId: uuid.nullable().optional(),
  topic: z.string().trim().max(1024).optional(),
  /** Canal privado: nega VIEW_CHANNEL para @everyone na criação. */
  private: z.boolean().optional(),
});

export const updateChannelSchema = z
  .object({
    name: channelNameSchema.optional(),
    topic: z.string().trim().max(1024).optional(),
    parentId: uuid.nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

export const overwriteSchema = z.object({
  targetType: z.enum(['role', 'member']),
  allow: bitfield,
  deny: bitfield,
});

export const roleColorSchema = z.number().int().min(0).max(0xffffff).nullable();

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: roleColorSchema.optional(),
  permissions: bitfield.optional(),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    color: roleColorSchema.optional(),
    permissions: bitfield.optional(),
    position: z.number().int().min(1).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada para atualizar.');

export const memberRolesSchema = z.object({ roleIds: z.array(uuid).max(50) });

export const INVITE_MAX_AGES = [0, 1800, 3600, 21600, 43200, 86400, 604800] as const;
export const createInviteSchema = z.object({
  /** 0 = nunca expira. */
  maxAgeSeconds: z
    .number()
    .int()
    .refine((v) => (INVITE_MAX_AGES as readonly number[]).includes(v), 'Validade inválida.')
    .default(86400),
  maxUses: z.number().int().min(0).max(100).default(0),
});

export const MESSAGE_MAX_LENGTH = 2000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const messageContent = z.string().max(MESSAGE_MAX_LENGTH, `Mensagens podem ter até ${MESSAGE_MAX_LENGTH} caracteres.`);

/** Texto, anexos (enviados antes por /channels/:id/attachments) ou os dois. */
export const sendMessageSchema = z
  .object({
    content: messageContent.default(''),
    attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS_PER_MESSAGE, `No máximo ${MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem.`).optional(),
    nonce: z.string().min(1).max(64).optional(),
    replyToId: uuid.optional(),
  })
  .refine((v) => v.content.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0, { message: 'A mensagem está vazia.', path: ['content'] });
export type SendMessageInput = z.input<typeof sendMessageSchema>;

export const editMessageSchema = z.object({ content: messageContent.refine((v) => v.trim().length > 0, 'A mensagem está vazia.') });

export const messageQuerySchema = z.object({
  before: uuid.optional(),
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

/** Um emoji (inclui sequências com modificadores) — nada de texto arbitrário em reações. */
export const emojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((v) => /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u.test(v), 'Emoji inválido.');

export const reportSchema = z
  .object({
    userId: uuid.optional(),
    messageId: uuid.optional(),
    reason: z.enum(['spam', 'harassment', 'hate', 'violence', 'sexual', 'other']),
    details: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.userId || v.messageId, 'Informe o usuário ou a mensagem denunciada.');

/** Menções no formato <@uuid>. */
export const MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;
export function extractMentions(content: string): string[] {
  return [...new Set([...content.matchAll(MENTION_RE)].map((m) => m[1]!))].slice(0, 50);
}
