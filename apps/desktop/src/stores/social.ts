import { create } from 'zustand';
import type { DmChannel, PublicPresence, Relationship } from '@nexo/protocol';
import { api } from './session';
import { useNav } from './nav';
import { useMessages } from './messages';

/** Quando cada presença foi alterada por evento em tempo real — para o retrato REST não sobrescrever o mais novo. */
const presenceTouched = new Map<string, number>();

/** Aplica um retrato de presenças sem desfazer eventos recebidos depois que a busca começou. */
function mergePresences(current: Record<string, PublicPresence>, snapshot: Record<string, PublicPresence>, startedAt: number) {
  const out = { ...snapshot };
  for (const [id, at] of presenceTouched) if (at >= startedAt && current[id]) out[id] = current[id];
  return out;
}

interface SocialState {
  loaded: boolean;
  relationships: Record<string, Relationship>;
  dms: Record<string, DmChannel>;
  presences: Record<string, PublicPresence>;
  load(): Promise<void>;
  refreshPresences(): Promise<void>;
  upsertRelationship(r: Relationship): void;
  removeRelationship(userId: string): void;
  upsertDm(dm: DmChannel): void;
  setPresence(userId: string, status: PublicPresence): void;
  openDm(userId: string): Promise<void>;
  reset(): void;
}

export const useSocial = create<SocialState>((set, get) => ({
  loaded: false,
  relationships: {},
  dms: {},
  presences: {},

  async load() {
    const startedAt = Date.now();
    const [rels, dms, presences] = await Promise.all([api.relationships(), api.dms(), api.presences()]);
    set({
      loaded: true,
      relationships: Object.fromEntries(rels.map((r) => [r.user.id, r])),
      dms: Object.fromEntries(dms.map((d) => [d.id, d])),
      presences: mergePresences(get().presences, presences, startedAt),
    });
    useMessages.getState().seedLastMessages(dms.map((d) => [d.id, d.lastMessageId]));
  },

  async refreshPresences() {
    const startedAt = Date.now();
    const snapshot = await api.presences();
    set({ presences: mergePresences(get().presences, snapshot, startedAt) });
  },

  upsertRelationship: (r) => set({ relationships: { ...get().relationships, [r.user.id]: r } }),
  removeRelationship(userId) {
    const { [userId]: _removed, ...rest } = get().relationships;
    set({ relationships: rest });
  },
  upsertDm: (dm) => set({ dms: { ...get().dms, [dm.id]: dm } }),
  setPresence(userId, status) {
    presenceTouched.set(userId, Date.now());
    set({ presences: { ...get().presences, [userId]: status } });
  },

  async openDm(userId) {
    const existing = Object.values(get().dms).find((d) => d.recipient.id === userId);
    const dm = existing ?? (await api.openDm(userId));
    get().upsertDm(dm);
    useNav.getState().go({ kind: 'dm', channelId: dm.id });
  },

  reset() {
    presenceTouched.clear();
    set({ loaded: false, relationships: {}, dms: {}, presences: {} });
  },
}));

export const presenceOf = (presences: Record<string, PublicPresence>, userId: string): PublicPresence => presences[userId] ?? 'offline';
