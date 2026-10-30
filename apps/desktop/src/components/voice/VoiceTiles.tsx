import type { PublicUser } from '@nexo/protocol';
import { Avatar } from '../ui';
import { VoiceStateIcons } from './VoiceBits';
import { WatchButton } from './ScreenShare';
import { TileCamera } from './Camera';
import { voice } from '../../voice/controller';
import { useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';
import { useVoice } from '../../stores/voice';
import { openProfile } from '../../stores/ui';

/** Grade de participantes com anel de fala e volume individual (até 200%). */
export function VoiceTiles({ channelId, users, compact }: { channelId: string; users: Map<string, PublicUser>; compact?: boolean }) {
  const room = useVoice((s) => s.rooms[channelId]);
  const speaking = useVoice((s) => s.speaking);
  const inRoom = useVoice((s) => s.channelId === channelId && s.status === 'connected');
  const selfId = useSession((s) => s.user?.id);
  const volumes = useSettings((s) => s.settings.userVolumes);
  const list = Object.values(room ?? {}).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));

  return (
    <ul className={`voice-tiles ${compact ? 'voice-tiles--compact' : ''}`} aria-label="Participantes">
      {list.map((p) => {
        const u = users.get(p.userId);
        const talking = inRoom && speaking[p.userId] && !p.selfMute && !p.suppressed;
        const isSelf = p.userId === selfId;
        const vol = volumes[p.userId] ?? 1;
        return (
          <li key={p.userId} className={`voice-tile ${talking ? 'voice-tile--talking' : ''} ${p.camera && inRoom ? 'voice-tile--video' : ''}`}>
            <button className="voice-tile__who" onClick={() => openProfile(p.userId)} aria-label={`${u?.displayName ?? 'Participante'}${talking ? ', falando' : ''}`}>
              {p.camera && inRoom ? (
                <TileCamera userId={p.userId} isSelf={isSelf} />
              ) : (
                <Avatar name={u?.displayName ?? '?'} seed={p.userId} imageId={u?.avatarId} size={compact ? 48 : 72} />
              )}
            </button>
            <span className="voice-tile__name">
              {u?.displayName ?? 'Participante'} {isSelf && <span className="muted">(você)</span>} <VoiceStateIcons state={p} />
              {p.stream && <span className="live-badge live-badge--inline">AO VIVO</span>}
            </span>
            {p.stream && !isSelf && inRoom && <WatchButton userId={p.userId} compact />}
            {inRoom && !isSelf && (
              <label className="voice-tile__vol">
                <span className="sr-only">Volume de {u?.displayName}</span>
                <input type="range" min={0} max={2} step={0.05} value={vol} onChange={(e) => voice.setUserVolume(p.userId, Number(e.target.value))} />
                <span className="mono">{Math.round(vol * 100)}%</span>
              </label>
            )}
          </li>
        );
      })}
    </ul>
  );
}
