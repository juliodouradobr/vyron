import { useState } from 'react';
import { Banner, Button, Modal } from './ui';
import { describeError } from '../services/api';
import { api } from '../stores/session';

const REASONS: Array<[string, string]> = [
  ['spam', 'Spam ou propaganda'],
  ['harassment', 'Assédio ou ameaça'],
  ['hate', 'Discurso de ódio'],
  ['violence', 'Violência'],
  ['sexual', 'Conteúdo sexual não solicitado'],
  ['other', 'Outro motivo'],
];

export function ReportDialog({ messageId, userId, who, onClose }: { messageId?: string; userId?: string; who: string; onClose: () => void }) {
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setState('busy');
    setError(null);
    try {
      await api.report({ messageId, userId, reason, details: details || undefined });
      setState('done');
    } catch (e) {
      setError(describeError(e));
      setState('idle');
    }
  };

  return (
    <Modal
      title={`Denunciar ${messageId ? 'mensagem de ' : ''}${who}`}
      size="sm"
      onClose={onClose}
      footer={
        state === 'done' ? (
          <Button onClick={onClose}>Fechar</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button variant="danger" onClick={submit} loading={state === 'busy'}>Enviar denúncia</Button>
          </>
        )
      }
    >
      {state === 'done' ? (
        <Banner tone="success">Denúncia enviada. Obrigado por ajudar a manter a comunidade segura.</Banner>
      ) : (
        <div className="stack">
          <fieldset className="radio-list">
            <legend className="field__label">Motivo</legend>
            {REASONS.map(([id, label]) => (
              <label key={id} className="check">
                <input type="radio" name="reason" value={id} checked={reason === id} onChange={() => setReason(id)} />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label className="field__label" htmlFor="report-details">Detalhes (opcional)</label>
            <textarea id="report-details" className="field__input field__textarea" maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
          </div>
          {error && <Banner tone="error">{error}</Banner>}
        </div>
      )}
    </Modal>
  );
}
