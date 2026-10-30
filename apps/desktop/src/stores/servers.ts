import { create } from 'zustand';
import { hasPermission, parsePermissions, type Channel, type Member, type ServerDetail, type ServerSummary } from '@nexo/protocol';
import { ApiError } from '../services/api';
import { api } from './session';
import { useMessages } from './messages';
import { useNav } from './nav';

interface ServersState {
  loaded: boolean;
  list: ServerSummary[];
  details: Record<string, ServerDetail>;
  members: Record<string, Member[]>;
  load(): Promise<void>;
  loadDetail(id: string): Promise<ServerDetail | null>;
  loadMembers(id: string): Promise<void>;
  setDetail(detail: ServerDetail): void;
  remove(id: string): void;
  create(name: string): Promise<ServerDetail>;
  join(code: string): Promise<ServerDetail>;
  reset(): void;
}

/** Primeiro canal de texto visível, na ordem da barra lateral. */
export function firstTextChannel(detail: ServerDetail): Channel | undefined {
  return sortChannels(detail.channels)
    .flatMap((g) => g.channels)
    .find((c) => c.type === 'text' || c.type === 'announcement');
}

/** Agrupa canais por categoria (sem categoria primeiro), cada grupo ordenado por posição. */
export function sortChannels(channels: Channel[]): Array<{ category: Channel | null; channels: Channel[] }> {
  const byPos = (a: Channel, b: Channel) => a.position - b.position || a.id.localeCompare(b.id);
  const cats = channels.filter((c) => c.type === 'category').sort(byPos);
  const groups: Array<{ category: Channel | null; channels: Channel[] }> = [
    { category: null, channels: channels.filter((c) => c.type !== 'category' && !cats.some((k) => k.id === c.parentId)).sort(byPos) },
  ];
  for (const cat of cats) groups.push({ category: cat, channels: channels.filter((c) => c.parentId === cat.id).sort(byPos) });
  return groups.filter((g) => g.category || g.channels.length);
}

export const can = (perms: string | undefined, bit: bigint) => !!perms && hasPermission(parsePermissions(perms), bit);

export const useServers = create<ServersState>((set, get) => ({
  loaded: false,
  list: [],
  details: {},
  members: {},

  async load() {
    const list = await api.servers();
    set({ list, loaded: true });
    // Detalhes de todos os servidores: necessários para indicadores de não lidas na barra lateral.
    await Promise.all(list.map((s) => get().loadDetail(s.id)));
  },

  async loadDetail(id) {
    try {
      const detail = await api.server(id);
      get().setDetail(detail);
      return detail;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) get().remove(id);
      return null;
    }
  },

  async loadMembers(id) {
    const members = await api.members(id);
    set({ members: { ...get().members, [id]: members } });
  },

  setDetail(detail) {
    const id = detail.server.id;
    const list = get().list.some((s) => s.id === id) ? get().list.map((s) => (s.id === id ? detail.server : s)) : [...get().list, detail.server];
    set({ list, details: { ...get().details, [id]: detail } });
    useMessages.getState().seedLastMessages(detail.channels.map((c) => [c.id, c.lastMessageId]));
    // Se o canal aberto deixou de ser visível (permissão retirada), sai dele.
    const route = useNav.getState().route;
    if (route.kind === 'server' && route.serverId === id && route.channelId && !detail.channels.some((c) => c.id === route.channelId)) {
      useNav.getState().go({ kind: 'server', serverId: id, channelId: firstTextChannel(detail)?.id ?? null });
    }
  },

  remove(id) {
    const { [id]: _d, ...details } = get().details;
    const { [id]: _m, ...members } = get().members;
    set({ list: get().list.filter((s) => s.id !== id), details, members });
    const route = useNav.getState().route;
    if (route.kind === 'server' && route.serverId === id) useNav.getState().go({ kind: 'friends' });
  },

  async create(name) {
    const detail = await api.createServer({ name });
    get().setDetail(detail);
    useNav.getState().go({ kind: 'server', serverId: detail.server.id, channelId: firstTextChannel(detail)?.id ?? null });
    return detail;
  },

  async join(code) {
    const detail = await api.joinInvite(code);
    get().setDetail(detail);
    useNav.getState().go({ kind: 'server', serverId: detail.server.id, channelId: firstTextChannel(detail)?.id ?? null });
    return detail;
  },

  reset: () => set({ loaded: false, list: [], details: {}, members: {} }),
}));
