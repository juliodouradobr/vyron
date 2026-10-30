import type { DispatchEvent } from '@nexo/protocol';
import { GatewayClient } from './gateway';
import { gatewayUrl } from './platform';
import { useConnection } from '../stores/connection';
import { useMessages } from '../stores/messages';
import { useServers } from '../stores/servers';
import { api, useSession } from '../stores/session';
import { useSocial } from '../stores/social';
import { useVoice } from '../stores/voice';
import { voice } from '../voice/controller';
import { loadMentions, onMessage, onRelationship, useNotify } from '../lib/notify/engine';

/** Liga o gateway ao ciclo de vida da sessão: conecta ao entrar, desconecta ao sair. */
let client: GatewayClient | null = null;
let readyCount = 0;
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Vários SERVER_SYNC seguidos (ex.: edição de cargos) viram uma única recarga. */
function scheduleServerSync(serverId: string) {
  clearTimeout(syncTimers.get(serverId));
  syncTimers.set(
    serverId,
    setTimeout(() => {
      syncTimers.delete(serverId);
      void useServers.getState().loadDetail(serverId);
    }, 150),
  );
}

export function handleDispatch(event: DispatchEvent): void {
  const social = useSocial.getState();
  const servers = useServers.getState();
  const messages = useMessages.getState();
  switch (event.type) {
    case 'USER_UPDATE':
      useSession.getState().setUser(event.user);
      break;
    case 'PRESENCE_UPDATE':
      social.setPresence(event.userId, event.status);
      break;
    case 'RELATIONSHIP_UPSERT': {
      const previous = social.relationships[event.relationship.user.id];
      social.upsertRelationship(event.relationship);
      onRelationship(event.relationship, previous);
      break;
    }
    case 'RELATIONSHIP_REMOVE':
      social.removeRelationship(event.userId);
      break;
    case 'DM_CREATE':
      social.upsertDm(event.channel);
      break;
    case 'SERVER_SYNC':
      scheduleServerSync(event.serverId);
      break;
    case 'SERVER_REMOVE':
      servers.remove(event.serverId);
      break;
    case 'MEMBERS_CHANGED':
      if (servers.members[event.serverId]) void servers.loadMembers(event.serverId);
      void servers.loadDetail(event.serverId);
      break;
    case 'MESSAGE_CREATE': {
      const m = event.message;
      // Primeira mensagem de uma conversa privada nova: recarrega a lista de DMs.
      const isServerChannel = Object.values(servers.details).some((d) => d.channels.some((c) => c.id === m.channelId));
      if (!isServerChannel && !social.dms[m.channelId]) void reloadDms().catch(() => {});
      messages.applyCreate(m);
      onMessage(m);
      break;
    }
    case 'MESSAGE_UPDATE':
      messages.applyUpdate(event.message);
      break;
    case 'MESSAGE_DELETE':
      messages.applyDelete(event.channelId, event.messageId);
      break;
    case 'REACTIONS_UPDATE':
      messages.applyReactions(event.channelId, event.messageId, event.reactions);
      break;
    case 'TYPING_START':
      messages.applyTyping(event.channelId, event.userId);
      break;
    case 'VOICE_STATE_UPDATE':
    case 'VOICE_READY':
    case 'VOICE_SIGNAL':
    case 'VOICE_ERROR':
    case 'STREAM_ERROR':
    case 'PLAY_REQUEST':
    case 'PLAY_DECLINED':
    case 'CALL_RING':
    case 'CALL_DECLINE':
      voice.handle(event);
      break;
    case 'SESSION_REVOKED':
      break;
  }
}

async function reloadDms() {
  const dms = await api.dms();
  for (const dm of dms) useSocial.getState().upsertDm(dm);
  useMessages.getState().seedLastMessages(dms.map((d) => [d.id, d.lastMessageId]));
}

/** Carrega (ou recarrega após reconexão) tudo o que pode ter mudado enquanto estávamos fora. */
export async function loadInitialState(): Promise<void> {
  await Promise.all([
    useSocial.getState().load(),
    useServers.getState().load(),
    useMessages.getState().loadReadStates(),
    refreshVoiceRooms(),
    // Menções recentes: contagem de não lidas e caixa de entrada (falha aqui não impede o resto).
    loadMentions().catch(() => {}),
  ]);
}

async function refreshVoiceRooms() {
  const startedAt = Date.now();
  const rooms = await api.voiceStates();
  useVoice.getState().setRooms(rooms, startedAt);
}

/**
 * Estado efêmero (presença, salas de voz) é recarregado sempre que o gateway fica pronto:
 * o que mudou antes do READY não chega como evento, e o que chegar depois vence o retrato.
 */
function refreshEphemeral() {
  void useSocial.getState().refreshPresences().catch(() => {});
  void refreshVoiceRooms().catch(() => {});
}

export function startRealtime(): GatewayClient {
  if (client) return client;
  const conn = useConnection.getState();
  readyCount = 0;
  client = new GatewayClient({
    url: gatewayUrl(),
    getToken: () => useSession.getState().token,
    callbacks: {
      onState: (state, info) => conn.set({ state, retryAt: info?.retryInMs ? Date.now() + info.retryInMs : null }),
      onReady: (user, sessionId) => {
        useSession.getState().setUser(user);
        useSession.getState().setSessionId(sessionId);
        // Na primeira conexão o AppShell já carregou o estado persistente; nas seguintes, ressincroniza tudo.
        if (readyCount++ === 0) refreshEphemeral();
        else {
          void loadInitialState().catch(() => {});
          const msgs = useMessages.getState();
          for (const id of Object.keys(msgs.channels)) if (msgs.channels[id]?.loaded) void msgs.loadLatest(id);
          msgs.retryAllFailed();
          voice.onReconnect();
        }
      },
      onDispatch: handleDispatch,
      onFatal: (code) => void useSession.getState().endSession(code === 4005 ? 'revoked' : 'expired'),
      onLatency: (ms) => conn.set({ latencyMs: ms }),
    },
  });
  const c = client;
  voice.attach((msg) => c.send(msg));
  client.start();
  window.addEventListener('online', onOnline);
  return client;
}

export function stopRealtime(): void {
  window.removeEventListener('online', onOnline);
  // Sair da conta encerra a chamada e solta o microfone imediatamente.
  voice.shutdown();
  client?.stop();
  client = null;
  for (const t of syncTimers.values()) clearTimeout(t);
  syncTimers.clear();
  useConnection.getState().set({ state: 'idle', latencyMs: null, retryAt: null });
  useSocial.getState().reset();
  useServers.getState().reset();
  useMessages.getState().reset();
  useNotify.getState().reset();
}

export const reconnectNow = () => client?.reconnectNow();
export const sendTyping = (channelId: string) => client?.sendTyping(channelId);

function onOnline() {
  client?.reconnectNow();
}
