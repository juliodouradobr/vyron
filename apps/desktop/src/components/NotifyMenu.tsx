import { useEffect, useRef, useState } from 'react';
import type { NotifyLevel } from '@nexo/protocol';
import { Bell, BellOff } from 'lucide-react';
import { IconButton } from './ui';
import { MUTE_OPTIONS, levelFor, muteActive, muteUntil, pruneMutes } from '../lib/notify/rules';
import { useSettings } from '../stores/settings';

const LEVELS: Array<[NotifyLevel, string]> = [
  ['all', 'Todas as mensagens'],
  ['mentions', 'Só quando me mencionarem'],
  ['none', 'Nada'],
];

function untilText(until: string): string {
  if (until === 'always') return 'até você reativar';
  const d = new Date(until);
  const today = new Date().toDateString() === d.toDateString();
  return `até ${today ? '' : `${d.toLocaleDateString('pt-BR')} `}${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Notificações da conversa aberta: silenciar o canal (por um tempo ou até reativar) e, em servidores,
 * o que avisar e silenciar o servidor inteiro. Fica salvo na conta (vale em todos os dispositivos).
 */
export function NotifyMenu({ channelId, channelName, serverId, serverName }: { channelId: string; channelName: string; serverId: string | null; serverName?: string }) {
  const [open, setOpen] = useState(false);
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const box = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const chMuted = muteActive(s.mutedChannels[channelId], now) ? s.mutedChannels[channelId]! : null;
  const srvMuted = serverId && muteActive(s.mutedServers[serverId], now) ? s.mutedServers[serverId]! : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const muteChannel = (until: string | null) => {
    const next = pruneMutes({ ...s.mutedChannels }, Date.now());
    if (until) next[channelId] = until;
    else delete next[channelId];
    update({ mutedChannels: next });
  };
  const muteServer = (until: string | null) => {
    if (!serverId) return;
    const next = pruneMutes({ ...s.mutedServers }, Date.now());
    if (until) next[serverId] = until;
    else delete next[serverId];
    update({ mutedServers: next });
  };
  const setLevel = (level: NotifyLevel | null) => {
    if (!serverId) return;
    const next = { ...s.serverNotify };
    if (level) next[serverId] = level;
    else delete next[serverId];
    update({ serverNotify: next });
  };

  const muted = !!chMuted || !!srvMuted;
  return (
    <div className="notify-menu" ref={box}>
      <IconButton label={muted ? 'Notificações silenciadas' : 'Notificações'} active={open || muted} onClick={() => setOpen((v) => !v)} tooltipSide="bottom">
        {muted ? <BellOff size={18} /> : <Bell size={18} />}
      </IconButton>
      {open && (
        <div className="popover notify-menu__pop" role="dialog" aria-label="Notificações desta conversa">
          <section>
            <h3 className="field__label">{serverId ? `#${channelName}` : 'Esta conversa'}</h3>
            {chMuted ? (
              <div className="notify-menu__state">
                <span>Silenciado {untilText(chMuted)}.</span>
                <button className="link" onClick={() => muteChannel(null)}>
                  Reativar
                </button>
              </div>
            ) : (
              <div className="notify-menu__opts">
                <span className="muted">Silenciar por:</span>
                {MUTE_OPTIONS.map((o) => (
                  <button key={o.label} className="chip" onClick={() => muteChannel(muteUntil(o.ms, Date.now()))}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </section>
          {serverId && (
            <section>
              <h3 className="field__label">Servidor {serverName}</h3>
              <div className="notify-menu__levels" role="radiogroup" aria-label="Avisar sobre">
                {LEVELS.map(([id, label]) => (
                  <label key={id} className="check">
                    <input type="radio" name="srv-level" checked={levelFor(s, serverId) === id} onChange={() => setLevel(id)} />
                    {label}
                    {s.serverNotify[serverId] === undefined && s.notifyServerDefault === id && <span className="muted"> (padrão)</span>}
                  </label>
                ))}
              </div>
              {srvMuted ? (
                <div className="notify-menu__state">
                  <span>Servidor silenciado {untilText(srvMuted)}.</span>
                  <button className="link" onClick={() => muteServer(null)}>
                    Reativar
                  </button>
                </div>
              ) : (
                <div className="notify-menu__opts">
                  <span className="muted">Silenciar servidor por:</span>
                  {MUTE_OPTIONS.map((o) => (
                    <button key={o.label} className="chip" onClick={() => muteServer(muteUntil(o.ms, Date.now()))}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <p className="field__hint">Silenciar só desliga avisos e sons. As mensagens continuam chegando normalmente.</p>
        </div>
      )}
    </div>
  );
}
