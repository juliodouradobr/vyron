/**
 * Regras de notificação (funções puras): quem avisa, quando e como.
 *
 * Ordem: própria mensagem → nunca; "Não perturbe" → nunca (nem som); olhando o canal com o app em foco
 * → nunca; canal/servidor silenciado → nunca; depois as preferências (DMs, menções, nível do servidor).
 * Aviso do sistema só com o app fora de foco; com o app em foco, no máximo um som.
 */
import type { NotifyLevel, PresenceStatus, UserSettings } from '@nexo/protocol';

export interface NotifyContext {
  settings: UserSettings;
  selfId: string;
  status: PresenceStatus;
  /** Janela do app em foco e visível. */
  focused: boolean;
  /** Canal aberto na tela agora. */
  viewingChannelId: string | null;
  now: number;
}

export interface MessageInfo {
  channelId: string;
  serverId: string | null;
  authorId: string;
  mentionsMe: boolean;
}

export interface Decision {
  /** Aviso do sistema (fora do app). */
  popup: boolean;
  sound: boolean;
  reason: string;
}

const none = (reason: string): Decision => ({ popup: false, sound: false, reason });

/** Silenciado agora? (`always` ou uma data ainda no futuro). */
export function muteActive(until: string | undefined, now: number): boolean {
  if (!until) return false;
  return until === 'always' || Date.parse(until) > now;
}

export function isMuted(s: UserSettings, serverId: string | null, channelId: string, now: number): boolean {
  return muteActive(s.mutedChannels[channelId], now) || (!!serverId && muteActive(s.mutedServers[serverId], now));
}

export const levelFor = (s: UserSettings, serverId: string): NotifyLevel => s.serverNotify[serverId] ?? s.notifyServerDefault;

function deliver(ctx: NotifyContext, reason: string): Decision {
  return { popup: !ctx.focused && ctx.settings.notifyDesktop, sound: ctx.settings.notifySounds, reason };
}

export function decideMessage(m: MessageInfo, ctx: NotifyContext): Decision {
  if (m.authorId === ctx.selfId) return none('própria mensagem');
  if (ctx.status === 'dnd') return none('não perturbe');
  if (ctx.focused && ctx.viewingChannelId === m.channelId) return none('canal aberto');
  if (isMuted(ctx.settings, m.serverId, m.channelId, ctx.now)) return none('silenciado');
  if (!m.serverId) return ctx.settings.notifyDms ? deliver(ctx, 'mensagem direta') : none('DMs desligadas');
  const level = levelFor(ctx.settings, m.serverId);
  if (level === 'none') return none('servidor: nada');
  if (m.mentionsMe) return ctx.settings.notifyMentions ? deliver(ctx, 'menção') : none('menções desligadas');
  return level === 'all' ? deliver(ctx, 'todas as mensagens') : none('servidor: só menções');
}

export function decideFriendRequest(ctx: NotifyContext): Decision {
  if (ctx.status === 'dnd') return none('não perturbe');
  return ctx.settings.notifyFriendRequests ? deliver(ctx, 'pedido de amizade') : none('pedidos desligados');
}

/** Opções de "silenciar por" oferecidas na interface. */
export const MUTE_OPTIONS: Array<{ label: string; ms: number | 'always' }> = [
  { label: '15 minutos', ms: 15 * 60_000 },
  { label: '1 hora', ms: 60 * 60_000 },
  { label: '8 horas', ms: 8 * 60 * 60_000 },
  { label: '24 horas', ms: 24 * 60 * 60_000 },
  { label: 'Até eu reativar', ms: 'always' },
];

export const muteUntil = (ms: number | 'always', now: number): string => (ms === 'always' ? 'always' : new Date(now + ms).toISOString());

/** Remove silenciamentos já vencidos (mantém as preferências pequenas). */
export function pruneMutes(r: Record<string, string>, now: number): Record<string, string> {
  return Object.fromEntries(Object.entries(r).filter(([, until]) => muteActive(until, now)));
}

/** Texto do aviso, respeitando "mostrar conteúdo". */
export function notificationBody(content: string, attachments: number, showPreview: boolean): string {
  if (!showPreview) return 'Nova mensagem';
  const text = content.replace(/\s+/g, ' ').trim();
  const files = attachments ? (attachments === 1 ? '📎 1 anexo' : `📎 ${attachments} anexos`) : '';
  const out = [text, files].filter(Boolean).join(' · ') || 'Nova mensagem';
  return out.length > 140 ? `${out.slice(0, 137)}…` : out;
}

/**
 * Menções ainda não lidas por canal: as mais novas que o ponto de leitura.
 * Ids são UUIDv7 (ordenam pelo tempo), então comparar texto basta.
 */
export function unreadMentions(mentionIds: Record<string, string[]>, readStates: Record<string, string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ch, ids] of Object.entries(mentionIds)) {
    const read = readStates[ch];
    const n = ids.filter((id) => !read || id > read).length;
    if (n) out[ch] = n;
  }
  return out;
}