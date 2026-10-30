import { Phone, PhoneOff } from 'lucide-react';
import { Avatar, Button } from '../ui';
import { useUserMap } from './useUserMap';
import { voice } from '../../voice/controller';
import { useNav } from '../../stores/nav';
import { useVoice } from '../../stores/voice';

/**
 * Chamada recebida. Recusar não abre o microfone nem cria conexão — só avisa quem ligou.
 * Aceitar entra na sala da conversa privada.
 */
export function IncomingCall() {
  const call = useVoice((s) => s.incomingCall);
  const users = useUserMap();
  if (!call) return null;
  const caller = users.get(call.from);
  const name = caller?.displayName ?? 'Alguém';

  return (
    <div className="incoming-call" role="alertdialog" aria-label={`Chamada de ${name}`}>
      <Avatar name={name} seed={call.from} size={64} />
      <div className="incoming-call__text">
        <strong>{name}</strong>
        <span className="muted">está ligando para você…</span>
      </div>
      <div className="row">
        <Button variant="danger" onClick={() => voice.declineCall()} aria-label="Recusar chamada">
          <PhoneOff size={16} aria-hidden /> Recusar
        </Button>
        <Button
          onClick={() => {
            useNav.getState().go({ kind: 'dm', channelId: call.channelId });
            void voice.acceptCall();
          }}
          aria-label="Atender chamada"
        >
          <Phone size={16} aria-hidden /> Atender
        </Button>
      </div>
    </div>
  );
}
