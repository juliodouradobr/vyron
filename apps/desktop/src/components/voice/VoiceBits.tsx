import type { PublicUser, VoiceParticipantState } from '@nexo/protocol';
import { HeadphoneOff, MicOff, ShieldOff } from 'lucide-react';
import { Avatar } from '../ui';
import { useVoice } from '../../stores/voice';
import { openProfile } from '../../stores/ui';

/** Ícones de estado de uma pessoa na sala: silenciado, ensurdecido, sem permissão de falar. */
export function VoiceStateIcons({ state }: { state: VoiceParticipantState }) {
  return (
    <span className="voice-icons">
      {state.suppressed && <ShieldOff size={14} aria-label="Sem permissão de falar" />}
      {state.selfDeaf ? <HeadphoneOff size={14} aria-label="Áudio desativado" /> : state.selfMute && <MicOff size={14} aria-label="Microfone silenciado" />}
    </span>
  );
}

/** Lista compacta de quem está na sala (sob o canal de voz na barra lateral). */
export function VoiceRoster({ channelId, users }: { channelId: string; users: Map<string, PublicUser> }) {
  const room = useVoice((s) => s.rooms[channelId]);
  const speaking = useVoice((s) => s.speaking);
  const mine = useVoice((s) => s.channelId === channelId);
  if (!room) return null;
  const list = Object.values(room).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  return (
    <ul className="voice-roster" aria-label="Pessoas na sala">
      {list.map((p) => {
        const u = users.get(p.userId);
        const talking = mine && speaking[p.userId] && !p.selfMute && !p.suppressed;
        return (
          <li key={p.userId}>
            <button className="voice-roster__item" onClick={() => openProfile(p.userId)}>
              <span className={`speak-ring ${talking ? 'speak-ring--on' : ''}`}>
                <Avatar name={u?.displayName ?? '?'} seed={p.userId} imageId={u?.avatarId} size={22} />
              </span>
              <span className="voice-roster__name">{u?.displayName ?? 'Alguém'}</span>
              <VoiceStateIcons state={p} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
