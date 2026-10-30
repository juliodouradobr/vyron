import { create } from 'zustand';

export type SettingsSection = 'account' | 'privacy' | 'voice' | 'notifications' | 'appearance' | 'accessibility' | 'shortcuts' | 'network' | 'about';

export type ModalState =
  | { kind: 'addServer' }
  | { kind: 'invite'; serverId: string }
  | { kind: 'createChannel'; serverId: string; parentId: string | null; type?: 'text' | 'voice' | 'announcement' | 'category' }
  | { kind: 'channelSettings'; serverId: string; channelId: string }
  | { kind: 'serverSettings'; serverId: string }
  | { kind: 'profile'; userId: string }
  | null;

interface UiState {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Em janelas estreitas o painel de canais vira uma gaveta. */
  sidebarOpen: boolean;
  modal: ModalState;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setSettingsSection(section: SettingsSection): void;
  toggleSidebar(open?: boolean): void;
  openModal(modal: ModalState): void;
  closeModal(): void;
}

export const useUi = create<UiState>((set, get) => ({
  settingsOpen: false,
  settingsSection: 'account',
  sidebarOpen: false,
  modal: null,
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? get().settingsSection }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleSidebar: (open) => set({ sidebarOpen: open ?? !get().sidebarOpen }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
}));

export const openProfile = (userId: string) => useUi.getState().openModal({ kind: 'profile', userId });
