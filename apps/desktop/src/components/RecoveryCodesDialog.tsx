import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatTag } from '@nexo/protocol';
import { Banner, Button, Modal } from './ui';
import { useSession } from '../stores/session';

/** Exibe códigos de recuperação uma única vez e só fecha depois que a pessoa confirma tê-los guardado. */
export function RecoveryCodesDialog({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const user = useSession((s) => s.user);
  const tag = user ? formatTag(user) : null;

  const copy = async () => {
    try {
      // O identificador vai junto: a recuperação pede os dois.
      await navigator.clipboard.writeText([tag && `Identificador: ${tag}`, ...codes].filter(Boolean).join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal
      title="Guarde seus códigos de recuperação"
      onClose={onDone}
      dismissible={false}
      footer={
        <Button onClick={onDone} disabled={!saved}>
          Concluir
        </Button>
      }
    >
      <div className="stack">
        <p className="muted">
          Se você esquecer a senha, um destes códigos devolve o acesso à conta. Cada código funciona uma vez. Eles não serão
          exibidos novamente.
        </p>
        {tag && (
          <p>
            Seu identificador é <strong className="mono">{tag}</strong>. Use-o para entrar e para que amigos encontrem você.
          </p>
        )}
        <ul className="codes mono" aria-label="Códigos de recuperação">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button variant="secondary" onClick={copy}>
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? 'Copiados' : 'Copiar códigos'}
        </Button>
        <Banner tone="warning">Guarde-os em um gerenciador de senhas ou em papel — não em uma mensagem no próprio app.</Banner>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Guardei meus códigos em um lugar seguro
        </label>
      </div>
    </Modal>
  );
}
