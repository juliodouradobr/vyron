import { useRef } from 'react';
import { Accessibility, Bell, Info, Keyboard, LogOut, Mic, Network, Palette, Shield, UserRound, X } from 'lucide-react';
import { useFocusTrap } from '../../components/ui';
import { useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';
import { useUi, type SettingsSection } from '../../stores/ui';
import { AccountSection } from './AccountSection';
import { VoiceSection } from './VoiceSection';
import { AboutSection, AccessibilitySection, AppearanceSection, NetworkSection, NotificationsSection, PrivacySection } from './PreferenceSections';

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: React.ReactNode;
  /** Etapa em que a categoria passa a existir; enquanto isso fica desabilitada. */
  stage?: number;
}

const GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Usuário',
    items: [
      { id: 'account', label: 'Minha conta', icon: <UserRound size={16} /> },
      { id: 'privacy', label: 'Privacidade', icon: <Shield size={16} /> },
    ],
  },
  {
    title: 'Aplicativo',
    items: [
      { id: 'voice', label: 'Voz e vídeo', icon: <Mic size={16} /> },
      { id: 'notifications', label: 'Notificações', icon: <Bell size={16} /> },
      { id: 'appearance', label: 'Aparência', icon: <Palette size={16} /> },
      { id: 'accessibility', label: 'Acessibilidade', icon: <Accessibility size={16} /> },
      { id: 'shortcuts', label: 'Atalhos', icon: <Keyboard size={16} />, stage: 3 },
      { id: 'network', label: 'Rede', icon: <Network size={16} /> },
      { id: 'about', label: 'Sobre', icon: <Info size={16} /> },
    ],
  },
];

const SAVE_TEXT = { idle: '', saving: 'Salvando…', saved: 'Alterações salvas', error: 'Falha ao salvar — tentaremos de novo na próxima alteração' };

export default function SettingsModal() {
  const { settingsSection, setSettingsSection, closeSettings } = useUi();
  const saveState = useSettings((s) => s.saveState);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, closeSettings);

  const current = GROUPS.flatMap((g) => g.items).find((i) => i.id === settingsSection);

  return (
    <div ref={ref} className="settings" role="dialog" aria-modal="true" aria-label="Configurações">
      <nav className="settings__nav" aria-label="Categorias de configuração">
        <div className="settings__nav-inner">
          {GROUPS.map((g) => (
            <div key={g.title} className="settings__group">
              <h2 className="settings__group-title">{g.title}</h2>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`settings__nav-item ${item.id === settingsSection ? 'settings__nav-item--active' : ''}`}
                  aria-current={item.id === settingsSection ? 'page' : undefined}
                  disabled={!!item.stage}
                  onClick={() => setSettingsSection(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.stage && <span className="side-link__badge">Etapa {item.stage}</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="settings__group">
            <button className="settings__nav-item settings__nav-item--danger" onClick={() => void useSession.getState().logout()}>
              <LogOut size={16} />
              <span>Sair</span>
            </button>
          </div>
        </div>
      </nav>
      <section className="settings__content" aria-labelledby="settings-title">
        <div className="settings__content-inner">
          <header className="settings__head">
            <h1 id="settings-title">{current?.label}</h1>
            <span className={`settings__save settings__save--${saveState}`} aria-live="polite">
              {SAVE_TEXT[saveState]}
            </span>
          </header>
          {settingsSection === 'account' && <AccountSection />}
          {settingsSection === 'privacy' && <PrivacySection />}
          {settingsSection === 'voice' && <VoiceSection />}
          {settingsSection === 'appearance' && <AppearanceSection />}
          {settingsSection === 'accessibility' && <AccessibilitySection />}
          {settingsSection === 'notifications' && <NotificationsSection />}
          {settingsSection === 'network' && <NetworkSection />}
          {settingsSection === 'about' && <AboutSection />}
        </div>
        <div className="settings__close">
          <button className="settings__close-btn" onClick={closeSettings} aria-label="Fechar configurações">
            <X size={18} />
          </button>
          <span aria-hidden>ESC</span>
        </div>
      </section>
    </div>
  );
}
