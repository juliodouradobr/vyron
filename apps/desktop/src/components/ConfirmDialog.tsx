import { useState, type ReactNode } from 'react';
import { Banner, Button, Modal, TextField } from './ui';

/**
 * Confirmação de ação destrutiva. Com `typeToConfirm`, exige digitar o texto (ex.: nome do servidor)
 * para ações irreversíveis de grande impacto.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  typeToConfirm,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = !typeToConfirm || typed.trim() === typeToConfirm;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError((err as Error).message || 'Não foi possível concluir.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={confirm} loading={busy} disabled={!ok}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="muted">{children}</div>
        {typeToConfirm && (
          <TextField label={`Digite "${typeToConfirm}" para confirmar`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        )}
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </Modal>
  );
}
