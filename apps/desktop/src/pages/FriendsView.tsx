import { useState, type FormEvent } from 'react';
import { formatTag, parseTag, type Relationship } from '@nexo/protocol';
import { Check, Menu, MessageSquare, ShieldOff, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { Avatar, Banner, Button, IconButton } from '../components/ui';
import { ConnectionBanner } from '../components/ConnectionIndicator';
import { ApiError, describeError } from '../services/api';
import { useNav, type FriendsTab } from '../stores/nav';
import { api } from '../stores/session';
import { presenceOf, useSocial } from '../stores/social';
import { openProfile, useUi } from '../stores/ui';

const PRESENCE_LABEL = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Offline', offline: 'Offline' } as const;

export function FriendsView() {
  const tab = useNav((s) => s.friendsTab);
  const setTab = useNav((s) => s.setFriendsTab);
  const relationships = useSocial((s) => s.relationships);
  const presences = useSocial((s) => s.presences);
  const loaded = useSocial((s) => s.loaded);
  const all = Object.values(relationships).sort((a, b) => a.user.displayName.localeCompare(b.user.displayName, 'pt-BR'));
  const pendingCount = all.filter((r) => r.type === 'incoming').length;

  const list: Relationship[] = {
    online: all.filter((r) => r.type === 'friend' && presenceOf(presences, r.user.id) !== 'offline'),
    all: all.filter((r) => r.type === 'friend'),
    pending: all.filter((r) => r.type === 'incoming' || r.type === 'outgoing'),
    blocked: all.filter((r) => r.type === 'blocked'),
    add: [],
  }[tab];

  const tabs: Array<[FriendsTab, string]> = [
    ['online', 'Online'],
    ['all', 'Todos'],
    ['pending', 'Pendentes'],
    ['blocked', 'Bloqueados'],
  ];

  return (
    <main className="main" aria-label="Amigos">
      <header className="main__header">
        <IconButton label="Abrir conversas" className="main__menu" onClick={() => useUi.getState().toggleSidebar(true)} tooltipSide="bottom">
          <Menu size={20} />
        </IconButton>
        <Users size={20} className="main__header-icon" aria-hidden />
        <h1>Amigos</h1>
        <span className="main__divider" aria-hidden />
        <div className="tabs" role="tablist" aria-label="Filtro de amigos">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'tab--on' : ''}`} onClick={() => setTab(id)}>
              {label}
              {id === 'pending' && pendingCount > 0 && <span className="count-badge">{pendingCount}</span>}
            </button>
          ))}
          <button role="tab" aria-selected={tab === 'add'} className={`tab tab--add ${tab === 'add' ? 'tab--add-on' : ''}`} onClick={() => setTab('add')}>
            Adicionar amigo
          </button>
        </div>
      </header>
      <ConnectionBanner />
      <div className="main__scroll friends">
        {tab === 'add' ? (
          <AddFriend />
        ) : !loaded ? null : list.length === 0 ? (
          <EmptyFriends tab={tab} />
        ) : (
          <>
            <h2 className="friends__count">
              {{ online: 'Online', all: 'Todos os amigos', pending: 'Pendentes', blocked: 'Bloqueados', add: '' }[tab]} — {list.length}
            </h2>
            <ul className="friends__list">
              {list.map((r) => (
                <FriendRow key={r.user.id} rel={r} presence={presenceOf(presences, r.user.id)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}

function FriendRow({ rel, presence }: { rel: Relationship; presence: keyof typeof PRESENCE_LABEL }) {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => () => {
    setError(null);
    fn().catch((e) => setError(describeError(e)));
  };
  const u = rel.user;
  const subtitle =
    rel.type === 'incoming' ? 'Pedido de amizade recebido' : rel.type === 'outgoing' ? 'Pedido de amizade enviado' : rel.type === 'blocked' ? 'Bloqueado' : PRESENCE_LABEL[presence];

  return (
    <li className="friend-row">
      <button className="friend-row__who" onClick={() => openProfile(u.id)}>
        <Avatar name={u.displayName} seed={u.id} imageId={u.avatarId} size={36} status={rel.type === 'friend' ? presence : undefined} />
        <span className="friend-row__names">
          <strong>{u.displayName}</strong> <span className="muted">{formatTag(u)}</span>
          <span className="friend-row__sub">{error ?? subtitle}</span>
        </span>
      </button>
      <div className="friend-row__actions">
        {rel.type === 'friend' && (
          <>
            <IconButton label="Enviar mensagem" onClick={run(() => useSocial.getState().openDm(u.id))}>
              <MessageSquare size={18} />
            </IconButton>
            <IconButton label="Desfazer amizade" danger onClick={run(() => api.removeRelationship(u.id))}>
              <UserMinus size={18} />
            </IconButton>
          </>
        )}
        {rel.type === 'incoming' && (
          <>
            <IconButton label="Aceitar" onClick={run(() => api.acceptFriend(u.id))}>
              <Check size={18} />
            </IconButton>
            <IconButton label="Recusar" danger onClick={run(() => api.removeRelationship(u.id))}>
              <X size={18} />
            </IconButton>
          </>
        )}
        {rel.type === 'outgoing' && (
          <IconButton label="Cancelar pedido" danger onClick={run(() => api.removeRelationship(u.id))}>
            <X size={18} />
          </IconButton>
        )}
        {rel.type === 'blocked' && (
          <IconButton label="Desbloquear" onClick={run(() => api.removeRelationship(u.id))}>
            <ShieldOff size={18} />
          </IconButton>
        )}
      </div>
    </li>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim().replace(/^@/, '');
    if (!name) return;
    if (!parseTag(name)) {
      setResult({ tone: 'error', text: 'Use o identificador completo, no formato Nome#00000.' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const rel = await api.sendFriendRequest(name);
      setResult({ tone: 'success', text: rel.type === 'friend' ? `Agora você e ${rel.user.displayName} são amigos!` : `Pedido enviado para ${formatTag(rel.user)}.` });
      setUsername('');
    } catch (err) {
      setResult({ tone: 'error', text: err instanceof ApiError ? err.message : describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="add-friend" aria-labelledby="add-friend-h">
      <h2 id="add-friend-h">Adicionar amigo</h2>
      <p className="muted">Digite o identificador da pessoa, no formato Nome#00000. Ela poderá aceitar ou recusar.</p>
      <form className={`add-friend__form ${result?.tone === 'error' ? 'add-friend__form--error' : ''}`} onSubmit={submit}>
        <input
          className="add-friend__input"
          aria-label="Identificador (Nome#00000)"
          placeholder="Nome#00000"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={40}
          autoFocus
          spellCheck={false}
        />
        <Button type="submit" disabled={!username.trim()} loading={busy}>
          <UserPlus size={16} aria-hidden /> Enviar pedido
        </Button>
      </form>
      {result && <Banner tone={result.tone}>{result.text}</Banner>}
    </section>
  );
}

function EmptyFriends({ tab }: { tab: FriendsTab }) {
  const text = {
    online: 'Nenhum amigo online agora.',
    all: 'Você ainda não adicionou ninguém.',
    pending: 'Nenhum pedido pendente.',
    blocked: 'Você não bloqueou ninguém.',
    add: '',
  }[tab];
  return (
    <div className="empty">
      <Users size={48} aria-hidden />
      <p>{text}</p>
      {tab !== 'blocked' && (
        <Button variant="secondary" onClick={() => useNav.getState().setFriendsTab('add')}>
          Adicionar amigo
        </Button>
      )}
    </div>
  );
}
