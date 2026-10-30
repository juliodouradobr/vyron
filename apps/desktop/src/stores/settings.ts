import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SETTINGS, userSettingsSchema, type UserSettings } from '@nexo/protocol';
import { isTauri } from '../services/platform';
import { api } from './session';

const CACHE_KEY = 'nexo.settings';
const SAVE_DELAY_MS = 600;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SettingsState {
  settings: UserSettings;
  saveState: SaveState;
  load(): Promise<void>;
  update(patch: Partial<UserSettings>): void;
  reset(): void;
}

/** Cópia local para aplicar tema/escala antes do login e sem rede. A fonte de verdade é o servidor. */
function readCache(): UserSettings {
  try {
    const parsed = userSettingsSchema.safeParse(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}'));
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeCache(s: UserSettings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* sem armazenamento local */
  }
}

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export function applySettings(s: UserSettings, root: HTMLElement = document.documentElement): void {
  const theme = s.theme === 'system' ? (systemDark() ? 'dark' : 'light') : s.theme;
  root.dataset.theme = theme;
  root.dataset.density = s.density;
  root.dataset.motion = s.reducedMotion || s.lowPowerMode ? 'reduced' : 'full';
  root.dataset.contrast = s.highContrast ? 'high' : 'normal';
  root.style.setProperty('--ui-scale', String(s.uiScale));
  if (isTauri()) void invoke('set_close_to_tray', { enabled: s.closeToTray }).catch(() => {});
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: readCache(),
  saveState: 'idle',

  async load() {
    try {
      const { settings } = await api.getSettings();
      set({ settings });
      writeCache(settings);
      applySettings(settings);
    } catch {
      /* mantém o cache local; a próxima alteração tenta sincronizar de novo */
    }
  },

  /** Aplica na hora (otimista) e salva no servidor com debounce. */
  update(patch) {
    const settings = userSettingsSchema.parse({ ...get().settings, ...patch });
    set({ settings, saveState: 'saving' });
    writeCache(settings);
    applySettings(settings);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api.putSettings(get().settings);
        set({ saveState: 'saved' });
      } catch {
        set({ saveState: 'error' });
      }
    }, SAVE_DELAY_MS);
  },

  reset() {
    get().update(DEFAULT_SETTINGS);
  },
}));

if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applySettings(useSettings.getState().settings));
}
