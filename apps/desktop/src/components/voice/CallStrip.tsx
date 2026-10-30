import { Phone, PhoneOff } from 'lucide-react';
import { Button } from '../ui';
import { VoiceTiles } from './VoiceTiles';
import { StreamStage } from './ScreenShare';
import { useUserMap } from './useUserMap';
import { voice } from '../../voice/controller';
import { useVoice } from '../../stores/voice';

/** Faixa de chamada no topo de uma conversa privada: participantes e entrar/sair. */
export function CallStrip({ channelId, recipientName }: { channelId: string; recipientName: string }) {
  const users = useUserMap();
  const room = useVoice((s) => s.rooms[channelId]);
  const mine = useVoice((s) => s.channelId === channelId);
  const outgoing = useVoice((s) => s.outgoingCall?.channelId === channelId);
  const count = Object.keys(room ?? {}).length;
  if (!count && !mine) return null;

  return (
    <section className="call-strip" aria-label="Chamada">
      <StreamStage channelId={channelId} users={users} />
      <VoiceTiles channelId={channelId} users={users} compact />
      {outgoing && <p className="call-strip__status">Chamando {recipientName}…</p>}
      <div className="row">
        {mine ? (
          <Button variant="danger" onClick={() => voice.leave()}>
            <PhoneOff size={16} aria-hidden /> Desligar
          </Button>
        ) : (
          <Button onClick={() => void voice.join(channelId)}>
            <Phone size={16} aria-hidden /> Entrar na chamada
          </Button>
        )}
      </div>
    </section>
  );
}
