import { useState, type FormEvent } from 'react';
import type { Message } from '@nexo/protocol';
import { Search, X } from 'lucide-react';
import { Avatar, Banner, Spinner } from '../../components/ui';
import { formatTimestamp, parseContent } from '../../lib/format';
import { describeError } from '../../services/api';
import { api } from '../../stores/session';
import type { ChatContext } from './useChatContext';

export function SearchPanel({ ctx, onClose }: { ctx: ChatContext; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await api.searchMessages(ctx.channelId, q.trim()));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const plain = (text: string) =>
    parseContent(text)
      .map((s) => (s.kind === 'mention' ? `@${ctx.users.find((u) => u.id === s.userId)?.displayName ?? '?'}` : s.text))
      .join('');

  return (
    <aside className="side-panel" aria-label="Busca">
      <header className="side-panel__head">
        <form className="search-box" onSubmit={submit} role="search">
          <Search size={14} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar mensagens" aria-label="Buscar mensagens" maxLength={100} />
        </form>
        <button className="icon-btn icon-btn--xs" aria-label="Fechar busca" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="side-panel__scroll">
        {busy && <Spinner />}
        {error && <Banner tone="error">{error}</Banner>}
        {results && !busy && (
          <>
            <p className="muted side-panel__count">{results.length ? `${results.length} resultado(s)` : 'Nada encontrado.'}</p>
            <ul className="search-results">
              {results.map((m) => (
                <li key={m.id} className="search-result">
                  <Avatar name={m.author.displayName} seed={m.author.id} imageId={m.author.avatarId} size={28} />
                  <div>
                    <strong>{m.author.displayName}</strong> <span className="muted">{formatTimestamp(m.createdAt)}</span>
                    <p>{plain(m.content)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
