import type { PresenceStatus, UserSettings } from './schemas';

/** Dados do próprio usuário. Nunca inclui hash de senha, IP ou campos internos. */
export interface SelfUser {
  id: string;
  username: string;
  /** Parte numérica do identificador público Name#00000, atribuída pelo servidor. */
  discriminator: string;
  displayName: string;
  bio: string;
  /** Id do arquivo do avatar/banner (baixado com login em /files/:id), ou null. */
  avatarId: string | null;
  bannerId: string | null;
  status: PresenceStatus;
  createdAt: string;
}

/** Visão pública de outro usuário — o mínimo necessário para exibir um perfil. */
export interface PublicUser {
  id: string;
  username: string;
  discriminator: string;
  displayName: string;
  bio: string;
  avatarId: string | null;
  bannerId: string | null;
  createdAt: string;
}

/** A visão pública da própria conta (o que outras pessoas veem). */
export const publicOfSelf = (u: SelfUser): PublicUser => ({
  id: u.id,
  username: u.username,
  discriminator: u.discriminator,
  displayName: u.displayName,
  bio: u.bio,
  avatarId: u.avatarId,
  bannerId: u.bannerId,
  createdAt: u.createdAt,
});

export interface AuthResponse {
  user: SelfUser;
  token: string;
  expiresAt: string;
}

export interface RegisterResponse extends AuthResponse {
  /** Exibidos uma única vez; o servidor guarda apenas hashes. */
  recoveryCodes: string[];
}

export interface LoginSession {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface SettingsResponse {
  settings: UserSettings;
  updatedAt: string | null;
}
