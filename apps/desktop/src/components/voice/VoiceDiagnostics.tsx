import { Modal } from '../ui';
import { quality } from '../../voice/adaptation';
import { useServers } from '../../stores/servers';
import { useSocial } from '../../stores/social';
import { useVoice } from '../../stores/voice';

const ROUTE: Record<string, string> = {
  host: 'Rede local (direta)',
  srflx: 'Direta pela internet — IPs visíveis entre vocês',
  prflx: 'Direta pela internet — IPs visíveis entre vocês',
  relay: 'Via servidor TURN — seu IP fica oculto',
};

const fmt = (v: number | null, unit: string, digits = 0) => (v == null ? '—' : `${v.toFixed(digits)} ${unit}`);

/** Números reais do WebRTC, por pessoa: ajuda a descobrir se o problema é rede, rota ou microfone. */
export function VoiceDiagnostics({ onClose }: { onClose: () => void }) {
  const { peers, transmitting, channelId, relayAvailable } = useVoice();
  const members = useServers((s) => s.members);
  const dms = useSocial((s) => s.dms);
  const nameOf = (id: string) =>
    Object.values(members).flat().find((m) => m.user.id === id)?.user.displayName ?? Object.values(dms).find((d) => d.recipient.id === id)?.recipient.displayName ?? 'Participante';

  const rows = Object.entries(peers);
  return (
    <Modal title="Diagnóstico de voz" onClose={onClose}>
      <div className="stack">
        <dl className="diag">
          <dt>Sala</dt>
          <dd className="mono">{channelId ? `${channelId.slice(0, 8)}…` : '—'}</dd>
          <dt>Seu microfone</dt>
          <dd>{transmitting ? 'transmitindo' : 'fechado (silenciado, sem voz detectada ou aguardando o push-to-talk)'}</dd>
          <dt>Relay TURN</dt>
          <dd>{relayAvailable ? 'disponível' : 'não configurado no servidor'}</dd>
        </dl>
        {rows.length === 0 ? (
          <p className="muted">Ninguém mais está na sala. As estatísticas aparecem quando outra pessoa entra.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Pessoa</th><th>Estado</th><th>Latência</th><th>Jitter</th><th>Perda</th><th>Envio / recebimento</th></tr>
            </thead>
            <tbody>
              {rows.map(([id, p]) => {
                const q = p.rttMs != null ? quality({ loss: p.loss ?? 0, jitterMs: p.jitterMs ?? 0, rttMs: p.rttMs }) : null;
                return (
                  <tr key={id}>
                    <td>
                      <span className={`dot dot--q-${q ?? 'unknown'}`} /> {nameOf(id)}
                      <div className="muted">{p.route ? ROUTE[p.route] : 'definindo rota…'}</div>
                    </td>
                    <td>{p.state}</td>
                    <td>{fmt(p.rttMs, 'ms')}</td>
                    <td>{fmt(p.jitterMs, 'ms')}</td>
                    <td>{p.loss == null ? '—' : `${(p.loss * 100).toFixed(1)}%`}</td>
                    <td>{fmt(p.sendKbps, 'kbps')} / {fmt(p.recvKbps, 'kbps')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="field__hint">
          Atualizado a cada 2 s. O bitrate de envio se ajusta sozinho entre 16 e 40 kbps conforme a pior conexão da sala.
        </p>
      </div>
    </Modal>
  );
}
