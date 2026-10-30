import { useState, type FormEvent } from 'react';
import { Banner, Button, Modal, TextField, Toggle } from '../ui';
import { channelIcon } from '../ServerSidebar';
import { describeError } from '../../services/api';
import { useNav } from '../../stores/nav';
import { api } from '../../stores/session';
import { useServers } from '../../stores/servers';
import { useUi } from '../../stores/ui';

type Kind = 'text' | 'voice' | 'announcement' | 'category';
const KINDS: Array<[Exclude<Kind, 'category'>, string, string]> = [
  ['text', 'Texto', 'Mensagens, emojis e respostas'],
  ['voice', 'Voz', 'Conversas por voz (chamadas na Etapa 3)'],
  ['announcement', 'Anúncios', 'Só moderadores publicam'],
];

export function CreateChannelModal({ serverId, parentId, type }: { serverId: string; parentId: string | null; type?: Kind }) {
  const close = useUi((s) => s.closeModal);
  const detail = useServers((s) => s.details[serverId]);
  const [kind, setKind] = useState<Kind>(type ?? 'text');
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string>(parentId ?? '');
  const [priv, setPriv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isCategory = kind === 'category';
  const categories = detail?.channels.filter((c) => c.type === 'category') ?? [];
  const preview = kind === 'text' || kind === 'announcement' ? name.trim().toLowerCase().replace(/\s+/g, '-') : name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ch = await api.createChannel(serverId, { name: name.trim(), type: kind, parentId: isCategory ? null : parent || null, private: priv });
      await useServers.getState().loadDetail(serverId);
      if (ch.type === 'text' || ch.type === 'announcement') useNav.getState().go({ kind: 'server', serverId, channelId: ch.id });
      close();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={isCategory ? 'Criar categoria' : 'Criar canal'} onClose={close} size="sm">
      <form className="stack" onSubmit={submit}>
        {!isCategory && (
          <fieldset className="radio-cards">
            <legend className="field__label">Tipo de canal</legend>
            {KINDS.map(([id, label, desc]) => (
              <label key={id} className={`radio-card ${kind === id ? 'radio-card--on' : ''}`}>
                <input type="radio" name="kind" value={id} checked={kind === id} onChange={() => setKind(id)} />
                {channelIcon(id, 20)}
                <span>
                  <strong>{label}</strong>
                  <span className="muted">{desc}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <TextField
          label={isCategory ? 'Nome da categoria' : 'Nome do canal'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          autoFocus
          hint={!isCategory && preview && preview !== name ? `Será criado como #${preview}` : undefined}
        />
        {!isCategory && categories.length > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="ch-parent">Categoria</label>
            <select id="ch-parent" className="field__input" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">Sem categoria</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <Toggle
          label={isCategory ? 'Categoria privada' : 'Canal privado'}
          description="Só você e quem você liberar depois (em Permissões do canal) poderão ver."
          checked={priv}
          onChange={setPriv}
        />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="row-end">
          <Button type="button" variant="ghost" onClick={close}>Cancelar</Button>
          <Button type="submit" loading={busy} disabled={!name.trim()}>Criar</Button>
        </div>
      </form>
    </Modal>
  );
}
