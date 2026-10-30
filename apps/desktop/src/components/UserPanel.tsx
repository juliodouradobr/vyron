import { useEffect, useRef, useState } from 'react';
import type { PresenceStatus } from '@nexo/protocol';
import { HeadphoneOff, Headphones, LogOut, Mic, MicOff, Settings } from 'lucide-react';
import { Avatar, IconButton, useFocusTrap } from './ui';
import { ConnectionIndicator } from './ConnectionIndicator';
import { VoicePanel } from './voice/VoicePanel';
import { api, useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';

export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'Disponível',
  idle: 'Ausente',
  dnd: 'Não perturbe',
  invisible: 'Invisível',
};

const STATUS_DESC: Record<PresenceStatus, string> = {
  online: 'Todos veem que você está online.',
  idle: 'Aparece como ausente.',
  dnd: 'Silencia as notificações da área de trabalho.',
  invisible: 'Você aparece offline, mas continua usando tudo normalmente.',
};

export function UserPanel() {
  const user = useSession((s) => s.user);
  const { micMuted, deafened, toggleMute, toggleDeafen } = useVoice();
  // Indicador visível de microfone ativo: só acende quando áudio está saindo de fato.
  const transmitting = useVoice((s) => s.transmitting && s.status === 'connected');
  const openSettings = useUi((s) => s.openSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!user) return null;

  return (
    <>
    <VoicePanel />
    <section className={`user-panel ${transmitting ? 'user-panel--live' : ''}`} aria-label="Sua conta e controles de voz">
      <button
        className="user-panel__identity"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${user.displayName}, ${STATUS_LABEL[user.status]}. Alterar status`}
      >
        <Avatar name={user.displayName} seed={user.id} imageId={user.avatarId} size={34} status={user.status} />
        <span className="user-panel__names">
          <span className="user-panel__display">{user.displayName}</span>
          <span className="user-panel__status">{STATUS_LABEL[user.status]}</span>
        </span>
      </button>
      <div className="user-panel__controls">
        <ConnectionIndicator />
        <IconButton
          label={micMuted ? 'Ativar microfone' : 'Silenciar microfone'}
          aria-pressed={micMuted}
          danger={micMuted}
          onClick={toggleMute}
        >
          {micMuted ? <MicOff size={18} /> : <Mic size={18} />}
        </IconButton>
        <IconButton
          label={deafened ? 'Ativar áudio' : 'Desativar áudio recebido'}
          aria-pressed={deafened}
          danger={deafened}
          onClick={toggleDeafen}
        >
          {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </IconButton>
        <IconButton label="Configurações" onClick={() => openSettings()}>
          <Settings size={18} />
        </IconButton>
      </div>
      {menuOpen && <StatusMenu current={user.status} onClose={() => setMenuOpen(false)} />}
    </section>
    </>
  );
}

function StatusMenu({ current, onClose }: { current: PresenceStatus; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusTrap(ref, onClose);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // setTimeout evita que o mesmo clique que abriu o menu o feche.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown));
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const choose = async (status: PresenceStatus) => {
    try {
      const user = await api.updateProfile({ status });
      useSession.getState().setUser(user);
      onClose();
    } catch {
      setError('Não foi possível alterar o status.');
    }
  };

  return (
    <div ref={ref} className="popover status-menu" role="menu" aria-label="Status">
      {(Object.keys(STATUS_LABEL) as PresenceStatus[]).map((s) => (
        <button key={s} role="menuitemradio" aria-checked={s === current} className="status-menu__item" onClick={() => choose(s)}>
          <span className={`status-menu__dot status--${s === 'invisible' ? 'offline' : s}`} />
          <span>
            <span className="status-menu__label">{STATUS_LABEL[s]}</span>
            <span className="status-menu__desc">{STATUS_DESC[s]}</span>
          </span>
        </button>
      ))}
      {error && <p className="status-menu__error">{error}</p>}
      <div className="popover__sep" />
      <button role="menuitem" className="status-menu__item status-menu__item--danger" onClick={() => void useSession.getState().logout()}>
        <LogOut size={16} />
        <span className="status-menu__label">Sair</span>
      </button>
    </div>
  );
}
