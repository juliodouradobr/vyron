import { useCallback, useEffect, useRef, useState } from 'react';
import type { Invite } from '@nexo/protocol';
import { Check, Copy } from 'lucide-react';
import { Banner, Button, Modal, Spinner } from '../ui';
import { formatExpiry } from '../../lib/format';
import { describeError } from '../../services/api';
import { api } from '../../stores/session';
import { useServers } from '../../stores/servers';
import { useUi } from '../../stores/ui';

const AGES: Array<[number, string]> = [
  [1800, '30 minutos'],
  [3600, '1 hora'],
  [21600, '6 horas'],
  [43200, '12 horas'],
  [86400, '1 dia'],
  [604800, '7 dias'],
  [0, 'Nunca'],
];
const USES: Array<[number, string]> = [
  [0, 'Sem limite'],
  [1, '1 uso'],
  [5, '5 usos'],
  [10, '10 usos'],
  [25, '25 usos'],
  [100, '100 usos'],
];

export function InviteModal({ serverId }: { serverId: string }) {
  const close = useUi((s) => s.closeModal);
  const name = useServers((s) => s.details[serverId]?.server.name ?? 'servidor');
  const [maxAge, setMaxAge] = useState(86400);
  const [maxUses, setMaxUses] = useState(0);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async (age: number, uses: number) => {
    setError(null);
    setCopied(false);
    try {
      setInvite(await api.createInvite(serverId, { maxAgeSeconds: age, maxUses: uses }));
    } catch (e) {
      setError(describeError(e));
    }
  }, [serverId]);

  // Ref evita criar dois convites quando o StrictMode executa o efeito duas vezes em desenvolvimento.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void generate(86400, 0);
  }, [generate]);

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setError('Não foi possível copiar. Selecione o código e copie manualmente.');
    }
  };

  return (
    <Modal title={`Convidar amigos para ${name}`} onClose={close} size="sm">
      <div className="stack">
        <p className="muted">Envie este código para quem você quer convidar. A pessoa usa “Adicionar um servidor → Entrar com convite”.</p>
        {invite ? (
          <div className="invite-code">
            <code className="mono" aria-label="Código do convite">{invite.code}</code>
            <Button onClick={copy} size="sm">
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        ) : (
          !error && <Spinner />
        )}
        {invite && (
          <p className="field__hint">
            {formatExpiry(invite.expiresAt)} · {invite.maxUses ? `até ${invite.maxUses} uso(s)` : 'usos ilimitados'}
          </p>
        )}
        <div className="grid-2">
          <div className="field">
            <label className="field__label" htmlFor="inv-age">Expira após</label>
            <select id="inv-age" className="field__input" value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
              {AGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="inv-uses">Número de usos</label>
            <select id="inv-uses" className="field__input" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
              {USES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row-end">
          <Button variant="secondary" onClick={() => void generate(maxAge, maxUses)}>Gerar novo código</Button>
        </div>
      </div>
    </Modal>
  );
}
