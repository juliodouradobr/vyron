import { useState, type FormEvent } from 'react';
import type { InvitePreview } from '@nexo/protocol';
import { Banner, Button, Modal, TextField } from '../ui';
import { describeError } from '../../services/api';
import { api } from '../../stores/session';
import { useServers } from '../../stores/servers';
import { useUi } from '../../stores/ui';

/** Aceita o código puro ou um link que termine nele. */
export const extractInviteCode = (input: string) => input.trim().split(/[/\s]/).filter(Boolean).pop() ?? '';

export function AddServerModal() {
  const close = useUi((s) => s.closeModal);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await useServers.getState().create(name.trim());
      close();
    });
  };

  const lookup = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => setPreview(await api.previewInvite(extractInviteCode(code))));
  };

  const join = () =>
    void run(async () => {
      await useServers.getState().join(preview!.code);
      close();
    });

  return (
    <Modal title={mode === 'create' ? 'Criar um servidor' : 'Entrar em um servidor'} onClose={close} size="sm">
      <div className="stack">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'segmented__on' : ''} onClick={() => { setMode('create'); setError(null); }}>
            Criar
          </button>
          <button role="tab" aria-selected={mode === 'join'} className={mode === 'join' ? 'segmented__on' : ''} onClick={() => { setMode('join'); setError(null); }}>
            Entrar com convite
          </button>
        </div>

        {mode === 'create' ? (
          <form className="stack" onSubmit={create}>
            <p className="muted">Seu servidor é onde você e seus amigos conversam. Ele começa com um canal de texto e um de voz.</p>
            <TextField label="Nome do servidor" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
            {error && <Banner tone="error">{error}</Banner>}
            <div className="row-end">
              <Button type="submit" loading={busy} disabled={name.trim().length < 2}>Criar servidor</Button>
            </div>
          </form>
        ) : preview ? (
          <div className="stack invite-preview">
            <p className="muted">Você foi convidado para</p>
            <h3 className="invite-preview__name">{preview.server.name}</h3>
            {preview.server.description && <p>{preview.server.description}</p>}
            <p className="muted">{preview.memberCount} membro(s)</p>
            {error && <Banner tone="error">{error}</Banner>}
            <div className="row-end">
              <Button variant="ghost" onClick={() => setPreview(null)}>Voltar</Button>
              <Button onClick={join} loading={busy}>Entrar no servidor</Button>
            </div>
          </div>
        ) : (
          <form className="stack" onSubmit={lookup}>
            <TextField label="Código do convite" placeholder="ex.: hTKzmak8Rq" value={code} onChange={(e) => setCode(e.target.value)} maxLength={200} autoFocus />
            {error && <Banner tone="error">{error}</Banner>}
            <div className="row-end">
              <Button type="submit" loading={busy} disabled={!code.trim()}>Ver convite</Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
