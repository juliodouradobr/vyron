import { create } from 'zustand';

export type FriendsTab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export type Route =
  | { kind: 'home' }
  | { kind: 'friends' }
  | { kind: 'dm'; channelId: string }
  | { kind: 'server'; serverId: string; channelId: string | null };

const KEY = 'nexo.nav';

interface NavState {
  route: Route;
  friendsTab: FriendsTab;
  /** Último canal aberto em cada servidor, para voltar a ele ao trocar de servidor. */
  lastChannel: Record<string, string>;
  memberListOpen: boolean;
  collapsed: Record<string, boolean>;
  go(route: Route): void;
  setFriendsTab(tab: FriendsTab): void;
  toggleMemberList(): void;
  toggleCategory(id: string): void;
}

function read(): Partial<NavState> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { route: v.route ?? { kind: 'friends' }, lastChannel: v.lastChannel ?? {}, memberListOpen: v.memberListOpen ?? true, collapsed: v.collapsed ?? {} };
  } catch {
    return {};
  }
}

export const useNav = create<NavState>((set, get) => ({
  route: { kind: 'friends' },
  friendsTab: 'online',
  lastChannel: {},
  memberListOpen: true,
  collapsed: {},
  ...read(),
  go(route) {
    if (route.kind === 'server' && route.channelId) set({ lastChannel: { ...get().lastChannel, [route.serverId]: route.channelId } });
    set({ route });
  },
  setFriendsTab: (friendsTab) => set({ friendsTab }),
  toggleMemberList: () => set({ memberListOpen: !get().memberListOpen }),
  toggleCategory: (id) => set({ collapsed: { ...get().collapsed, [id]: !get().collapsed[id] } }),
}));

useNav.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ route: s.route, lastChannel: s.lastChannel, memberListOpen: s.memberListOpen, collapsed: s.collapsed }));
  } catch {
    /* sem armazenamento */
  }
});
