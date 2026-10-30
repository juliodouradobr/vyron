/**
 * Motor de notificações: aplica as regras (rules.ts) aos eventos em tempo real e mostra o aviso.
 *
 * - App para Windows: aviso nativo do sistema, pelo núcleo (comando `notify`).
 * - Navegador: Notification API — só depois que a pessoa permitir, por um botão nas configurações
 *   (o app nunca pede a permissão sozinho).
 * Também mantém a contagem de menções não lidas e o número no título da janela.
 */
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import type { Message, Relationship } from '@nexo/protocol';
import { isTauri } from '../../services/platform';
import { useMessages, isUnread } from '../../stores/messages';
import { useNav } from '../../stores/nav';
import { useServers } from '../../stores/servers';
import { api, useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';
import { useSocial } from '../../stores/social';
import { playMessage } from '../../voice/sounds';
import { parseContent } from '../format';
import { decideFriendRequest, decideMessage, notificationBody, unreadMentions, type NotifyContext } from './rules';

interface NotifyState {
  /** Ids de mensagens que me mencionam, por canal (para contar as não lidas). */
  mentionIds: Record<string, string[]>;
  /** Permissão do navegador para avisos ('unsupported' fora do navegador ou sem a API). */
  permission: NotificationPermission | 'unsupported' | 'native';
  addMention(channelId: string, messageId: string): void;
  seedMentions(list: Message[]): void;
  reset(): void;
}

const browserPermission = (): NotifyState['permission'] =>
  isTauri() ? 'native' : typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export const useNotify = create<NotifyState>((set, get) => ({
  mentionIds: {},
  permission: browserPermission(),
  addMention(channelId, messageId) {
    const cur = get().mentionIds[channelId] ?? [];
    if (cur.includes(messageId)) return;
    set({ mentionIds: { ...get().mentionIds, [channelId]: [...cur, messageId].slice(-100) } });
  },
  seedMentions(list) {
    const next: Record<string, string[]> = { ...get().mentionIds };
    for (const m of list) {
      const cur = next[m.channelId] ?? [];
      if (!cur.includes(m.id)) next[m.channelId] = [...cur, m.id].slice(-100);
    }
    set({ mentionIds: next });
  },
  reset: () => set({ mentionIds: {} }),
}));

export { unreadMentions } from './rules';

/** Pedido explícito da pessoa (botão nas configurações). */
export async function requestBrowserPermission(): Promise<void> {
  if (typeof Notification === 'undefined' || isTauri()) return;
  const p = await Notification.requestPermission();
  useNotify.setState({ permission: p });
}

const focused = () => document.visibilityState === 'visible' && document.hasFocus();

function context(): NotifyContext | null {
  const user = useSession.getState().user;
  if (!user) return null;
  const route = useNav.getState().route;
  return {
    settings: useSettings.getState().settings,
    selfId: user.id,
    status: user.status,
    focused: focused(),
    viewingChannelId: route.kind === 'dm' || route.kind === 'server' ? route.channelId : null,
    now: Date.now(),
  };
}

function serverOf(channelId: string) {
  for (const d of Object.values(useServers.getState().details)) {
    const ch = d.channels.find((c) => c.id === channelId);
    if (ch) return { server: d.server, channel: ch };
  }
  return null;
}

/** Texto legível de uma mensagem (menções viram @nome). */
function plainText(m: Message): string {
  return parseContent(m.content)
    .map((s) => (s.kind === 'mention' ? `@${nameOf(s.userId)}` : s.text))
    .join('');
}

/** Nome de exibição de alguém que o app já conhece (membros, amigos, DMs, a própria conta). */
export function nameOf(userId: string): string {
  const self = useSession.getState().user;
  if (self?.id === userId) return self.displayName;
  const social = useSocial.getState();
  const known =
    social.relationships[userId]?.user ??
    Object.values(social.dms).find((d) => d.recipient.id === userId)?.recipient ??
    Object.values(useServers.getState().members)
      .flat()
      .find((x) => x.user.id === userId)?.user;
  return known?.displayName ?? 'alguém';
}

async function show(title: string, body: string, onClick: () => void) {
  if (isTauri()) {
    // Aviso nativo do Windows (o clique no aviso ainda não volta para a conversa: limitação do plugin).
    await invoke('notify', { title, body }).catch(() => {});
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, silent: true, tag: title });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

/** Botão "Testar" das configurações: mostra um aviso de verdade (e toca o som, se ligado). */
export async function testNotification(): Promise<'shown' | 'blocked'> {
  if (useSettings.getState().settings.notifySounds) playMessage();
  if (!isTauri() && (typeof Notification === 'undefined' || Notification.permission !== 'granted')) return 'blocked';
  await show('VYRON', 'As notificações estão funcionando.', () => {});
  return 'shown';
}

export function onMessage(m: Message): void {
  const ctx = context();
  if (!ctx) return;
  const where = serverOf(m.channelId);
  const mentionsMe = m.mentions.includes(ctx.selfId);
  if (mentionsMe && m.author.id !== ctx.selfId && !(ctx.focused && ctx.viewingChannelId === m.channelId)) {
    useNotify.getState().addMention(m.channelId, m.id);
  }
  const d = decideMessage({ channelId: m.channelId, serverId: where?.server.id ?? null, authorId: m.author.id, mentionsMe }, ctx);
  if (d.sound) playMessage();
  if (!d.popup) return;
  const title = where ? `${m.author.displayName} em #${where.channel.name} (${where.server.name})` : m.author.displayName;
  const body = notificationBody(plainText(m), m.attachments?.length ?? 0, ctx.settings.showMessagePreviewInNotifications);
  void show(title, body, () =>
    useNav.getState().go(where ? { kind: 'server', serverId: where.server.id, channelId: m.channelId } : { kind: 'dm', channelId: m.channelId }),
  );
}

export function onRelationship(r: Relationship, previous: Relationship | undefined): void {
  if (r.type !== 'incoming' || previous?.type === 'incoming') return;
  const ctx = context();
  if (!ctx) return;
  const d = decideFriendRequest(ctx);
  if (d.sound) playMessage();
  if (d.popup) {
    void show('Pedido de amizade', `${r.user.displayName} quer ser seu amigo no VYRON.`, () => {
      useNav.getState().setFriendsTab('pending');
      useNav.getState().go({ kind: 'friends' });
    });
  }
}

/** Carrega menções recentes (para a contagem e a caixa de entrada). */
export async function loadMentions(): Promise<Message[]> {
  const list = await api.mentions();
  useNotify.getState().seedMentions(list);
  return list;
}

/* ---------------- título da janela ---------------- */

let started = false;
/** Mantém "(N) VYRON" no título: menções não lidas + conversas privadas não lidas. */
export function startTitleBadge(): () => void {
  if (started) return () => {};
  started = true;
  const update = () => {
    const msgs = useMessages.getState();
    const mentions = Object.values(unreadMentions(useNotify.getState().mentionIds, msgs.readStates)).reduce((a, b) => a + b, 0);
    const dms = Object.keys(useSocial.getState().dms).filter((id) => isUnread(msgs.lastMessageId[id], msgs.readStates[id])).length;
    const n = mentions + dms;
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) VYRON` : 'VYRON';
  };
  const unsubs = [useMessages.subscribe(update), useNotify.subscribe(update), useSocial.subscribe(update)];
  update();
  return () => {
    unsubs.forEach((u) => u());
    started = false;
    document.title = 'VYRON';
  };
}
