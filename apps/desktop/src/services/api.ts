import type {
  ApiErrorBody,
  Attachment,
  AuthResponse,
  ChangePasswordInput,
  LoginInput,
  LoginSession,
  RecoveryInput,
  RegisterInput,
  RegisterResponse,
  SelfUser,
  SettingsResponse,
  UpdateProfileInput,
  UserSettings,
  AuditEntry,
  Channel,
  DmChannel,
  Invite,
  InvitePreview,
  Member,
  Message,
  PublicPresence,
  PublicUser,
  ReadState,
  Relationship,
  Role,
  ServerDetail,
  ServerSummary,
  VoiceParticipantState,
} from '@nexo/protocol';
import { getApiUrl } from './platform';

export type ClientErrorCode = ApiErrorBody['error']['code'] | 'NETWORK' | 'TIMEOUT';

export class ApiError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status = 0,
    readonly retryAfter?: number,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  getToken: () => string | null;
  /** Chamado quando uma requisição autenticada recebe 401 — a sessão acabou no servidor. */
  onUnauthorized?: (code: ClientErrorCode) => void;
}

export function createApiClient(opts: ApiClientOptions) {
  // Lido a cada pedido: trocar de servidor na tela de entrada vale na hora, sem reiniciar o app.
  const baseOf = () => opts.baseUrl ?? getApiUrl();
  const doFetch: Fetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = auth ? opts.getToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseOf()}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new ApiError('TIMEOUT', 'O servidor demorou demais para responder.');
      throw new ApiError('NETWORK', 'Não foi possível conectar ao servidor.');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return undefined as T;
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const e = (data as ApiErrorBody | undefined)?.error;
      const err = new ApiError(
        e?.code ?? 'INTERNAL',
        e?.message ?? `Erro inesperado (${res.status}).`,
        res.status,
        e?.retryAfter,
        e?.details as ApiError['details'],
      );
      if (res.status === 401 && token) opts.onUnauthorized?.(err.code);
      throw err;
    }
    return data as T;
  }

  const toApiError = (status: number, body: unknown, token: string | null): ApiError => {
    const e = (body as ApiErrorBody | undefined)?.error;
    const err = new ApiError(e?.code ?? 'INTERNAL', e?.message ?? `Erro inesperado (${status}).`, status, e?.retryAfter, e?.details as ApiError['details']);
    if (status === 401 && token) opts.onUnauthorized?.(err.code);
    return err;
  };

  /**
   * Envio de arquivo como corpo binário, com progresso (o fetch não informa progresso de envio).
   * Sem tempo limite fixo: arquivos grandes em redes lentas demoram; `signal` cancela.
   */
  function upload<T>(method: 'POST' | 'PUT', path: string, file: Blob, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const token = opts.getToken();
      xhr.open(method, `${baseOf()}/api/v1${path}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response as T) : reject(toApiError(xhr.status, xhr.response, token)));
      xhr.onerror = () => reject(new ApiError('NETWORK', 'Não foi possível enviar o arquivo.'));
      xhr.onabort = () => reject(new ApiError('NETWORK', 'Envio cancelado.'));
      signal?.addEventListener('abort', () => xhr.abort());
      xhr.send(file);
    });
  }

  /** Conteúdo de um arquivo, com login (o servidor confere a permissão a cada pedido). */
  async function fileBlob(id: string): Promise<Blob> {
    const token = opts.getToken();
    let res: Response;
    try {
      res = await doFetch(`${baseOf()}/api/v1/files/${encodeURIComponent(id)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    } catch {
      throw new ApiError('NETWORK', 'Não foi possível baixar o arquivo.');
    }
    if (!res.ok) throw toApiError(res.status, await res.json().catch(() => undefined), token);
    return res.blob();
  }

  return {
    uploadAttachment: (channelId: string, file: Blob, filename: string, onProgress?: (f: number) => void, signal?: AbortSignal) =>
      upload<Attachment>('POST', `/channels/${encodeURIComponent(channelId)}/attachments?filename=${encodeURIComponent(filename)}`, file, onProgress, signal),
    deleteAttachment: (id: string) => request<void>('DELETE', `/attachments/${encodeURIComponent(id)}`),
    fileBlob,
    setProfileImage: (kind: 'avatar' | 'banner', file: Blob, filename: string, onProgress?: (f: number) => void) =>
      upload<{ user: SelfUser }>('PUT', `/users/@me/${kind}?filename=${encodeURIComponent(filename)}`, file, onProgress),
    removeProfileImage: (kind: 'avatar' | 'banner') => request<{ user: SelfUser }>('DELETE', `/users/@me/${kind}`),
    health: () => request<{ ok: boolean }>('GET', '/health', undefined, false),
    register: (input: RegisterInput) => request<RegisterResponse>('POST', '/auth/register', input, false),
    login: (input: LoginInput) => request<AuthResponse>('POST', '/auth/login', input, false),
    recover: (input: RecoveryInput) => request<AuthResponse>('POST', '/auth/recover', input, false),
    logout: () => request<void>('POST', '/auth/logout'),
    me: () => request<SelfUser>('GET', '/users/@me'),
    updateProfile: (input: UpdateProfileInput) => request<SelfUser>('PATCH', '/users/@me', input),
    changePassword: (input: ChangePasswordInput) => request<void>('POST', '/users/@me/password', input),
    regenerateRecoveryCodes: (password: string) =>
      request<{ recoveryCodes: string[] }>('POST', '/users/@me/recovery-codes', { password }),
    sessions: () => request<LoginSession[]>('GET', '/users/@me/sessions'),
    revokeSession: (id: string) => request<void>('DELETE', `/users/@me/sessions/${encodeURIComponent(id)}`),
    revokeOtherSessions: () => request<{ revoked: number }>('DELETE', '/users/@me/sessions'),
    getSettings: () => request<SettingsResponse>('GET', '/users/@me/settings'),
    putSettings: (s: UserSettings) => request<SettingsResponse>('PUT', '/users/@me/settings', s),

    // ---- social ----
    relationships: () => request<Relationship[]>('GET', '/users/@me/relationships'),
    sendFriendRequest: (username: string) => request<Relationship>('POST', '/users/@me/relationships', { username }),
    acceptFriend: (userId: string) => request<Relationship>('PUT', `/users/@me/relationships/${enc(userId)}`),
    removeRelationship: (userId: string) => request<void>('DELETE', `/users/@me/relationships/${enc(userId)}`),
    block: (userId: string) => request<Relationship>('PUT', `/users/@me/relationships/${enc(userId)}/block`),
    profile: (userId: string) => request<UserProfile>('GET', `/users/${enc(userId)}`),
    presences: () => request<Record<string, PublicPresence>>('GET', '/users/@me/presences'),
    dms: () => request<DmChannel[]>('GET', '/users/@me/channels'),
    openDm: (recipientId: string) => request<DmChannel>('POST', '/users/@me/channels', { recipientId }),
    readStates: () => request<ReadState[]>('GET', '/users/@me/read-states'),
    mentions: (before?: string) => request<Message[]>('GET', `/users/@me/mentions${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    report: (input: { userId?: string; messageId?: string; reason: string; details?: string }) => request<void>('POST', '/reports', input),

    // ---- servidores ----
    servers: () => request<ServerSummary[]>('GET', '/users/@me/servers'),
    createServer: (input: { name: string; description?: string }) => request<ServerDetail>('POST', '/servers', input),
    server: (id: string) => request<ServerDetail>('GET', `/servers/${enc(id)}`),
    updateServer: (id: string, input: { name?: string; description?: string }) => request<ServerDetail>('PATCH', `/servers/${enc(id)}`, input),
    deleteServer: (id: string) => request<void>('DELETE', `/servers/${enc(id)}`),
    leaveServer: (id: string) => request<void>('DELETE', `/users/@me/servers/${enc(id)}`),
    members: (id: string) => request<Member[]>('GET', `/servers/${enc(id)}/members`),
    setMemberRoles: (id: string, userId: string, roleIds: string[]) =>
      request<{ roleIds: string[] }>('PUT', `/servers/${enc(id)}/members/${enc(userId)}/roles`, { roleIds }),
    kick: (id: string, userId: string) => request<void>('DELETE', `/servers/${enc(id)}/members/${enc(userId)}`),
    createRole: (id: string, input: { name: string; color?: number | null; permissions?: string }) => request<Role>('POST', `/servers/${enc(id)}/roles`, input),
    updateRole: (id: string, roleId: string, input: Partial<Pick<Role, 'name' | 'color' | 'permissions' | 'position'>>) =>
      request<Role>('PATCH', `/servers/${enc(id)}/roles/${enc(roleId)}`, input),
    deleteRole: (id: string, roleId: string) => request<void>('DELETE', `/servers/${enc(id)}/roles/${enc(roleId)}`),
    createInvite: (id: string, input: { maxAgeSeconds: number; maxUses: number }) => request<Invite>('POST', `/servers/${enc(id)}/invites`, input),
    invites: (id: string) => request<Invite[]>('GET', `/servers/${enc(id)}/invites`),
    revokeInvite: (code: string) => request<void>('DELETE', `/invites/${enc(code)}`),
    previewInvite: (code: string) => request<InvitePreview>('GET', `/invites/${enc(code)}`),
    joinInvite: (code: string) => request<ServerDetail>('POST', `/invites/${enc(code)}`),
    auditLog: (id: string) => request<AuditEntry[]>('GET', `/servers/${enc(id)}/audit-log`),

    // ---- canais e mensagens ----
    createChannel: (serverId: string, input: { name: string; type: string; parentId?: string | null; topic?: string; private?: boolean }) =>
      request<Channel>('POST', `/servers/${enc(serverId)}/channels`, input),
    updateChannel: (id: string, input: { name?: string; topic?: string; parentId?: string | null; position?: number }) =>
      request<Channel>('PATCH', `/channels/${enc(id)}`, input),
    deleteChannel: (id: string) => request<void>('DELETE', `/channels/${enc(id)}`),
    putOverwrite: (id: string, targetId: string, input: { targetType: 'role' | 'member'; allow: string; deny: string }) =>
      request<Channel | null>('PUT', `/channels/${enc(id)}/overwrites/${enc(targetId)}`, input),
    deleteOverwrite: (id: string, targetId: string) => request<void>('DELETE', `/channels/${enc(id)}/overwrites/${enc(targetId)}`),
    messages: (id: string, q: { before?: string; limit?: number } = {}) =>
      request<Message[]>('GET', `/channels/${enc(id)}/messages${query(q)}`),
    searchMessages: (id: string, q: string) => request<Message[]>('GET', `/channels/${enc(id)}/messages/search${query({ q })}`),
    sendMessage: (id: string, input: { content: string; nonce: string; replyToId?: string; attachmentIds?: string[] }) => request<Message>('POST', `/channels/${enc(id)}/messages`, input),
    editMessage: (id: string, messageId: string, content: string) =>
      request<Message>('PATCH', `/channels/${enc(id)}/messages/${enc(messageId)}`, { content }),
    deleteMessage: (id: string, messageId: string) => request<void>('DELETE', `/channels/${enc(id)}/messages/${enc(messageId)}`),
    addReaction: (id: string, messageId: string, emoji: string) =>
      request<void>('PUT', `/channels/${enc(id)}/messages/${enc(messageId)}/reactions/${enc(emoji)}`),
    removeReaction: (id: string, messageId: string, emoji: string) =>
      request<void>('DELETE', `/channels/${enc(id)}/messages/${enc(messageId)}/reactions/${enc(emoji)}`),
    ack: (id: string, messageId: string) => request<void>('POST', `/channels/${enc(id)}/ack`, { messageId }),
    voiceStates: () => request<Record<string, VoiceParticipantState[]>>('GET', '/voice/states'),
  };
}

const enc = encodeURIComponent;
function query(q: Record<string, string | number | undefined>): string {
  const p = Object.entries(q).filter(([, v]) => v !== undefined) as Array<[string, string | number]>;
  return p.length ? `?${p.map(([k, v]) => `${k}=${enc(String(v))}`).join('&')}` : '';
}

export interface UserProfile {
  user: PublicUser;
  relationship: Relationship['type'] | null;
  mutualServers: Array<{ id: string; name: string }>;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Mensagem amigável para exibir na interface. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED' || err.code === 'ACCOUNT_LOCKED') {
      const wait = err.retryAfter ? ` Tente novamente em ${formatWait(err.retryAfter)}.` : '';
      return err.message.replace(/\s*$/, '') + wait;
    }
    return err.message;
  }
  return 'Algo deu errado. Tente novamente.';
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}
