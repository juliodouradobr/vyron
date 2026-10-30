import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { LoginSession } from '@nexo/protocol';
import { changePasswordSchema, formatTag, updateProfileSchema } from '@nexo/protocol';
import { Laptop, Trash2 } from 'lucide-react';
import { Avatar, Banner, Button, Modal, Spinner, TextField } from '../../components/ui';
import { ApiError, describeError } from '../../services/api';
import { ProfileBanner, ProfileImageControls } from '../../components/ProfileImages';
import { api, useSession } from '../../stores/session';

export function AccountSection() {
  return (
    <div className="stack-lg">
      <ProfileForm />
      <PasswordForm />
      <RecoveryCodes />
      <Sessions />
    </div>
  );
}

function ProfileForm() {
  const user = useSession((s) => s.user)!;
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = displayName !== user.displayName || bio !== user.bio;
  const [copied, setCopied] = useState(false);
  const copyTag = () => {
    navigator.clipboard.writeText(formatTag(user)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError('Não foi possível copiar. Selecione o identificador e copie manualmente.'),
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setOk(false);
    const parsed = updateProfileSchema.safeParse({ displayName, bio });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Dados inválidos.');
    setError(null);
    setBusy(true);
    try {
      useSession.getState().setUser(await api.updateProfile(parsed.data));
      setOk(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="profile-h">
      <div className="profile-card">
        <ProfileBanner bannerId={user.bannerId} className="profile-card__banner" />
        <div className="profile-card__row">
          <Avatar name={displayName || user.username} seed={user.id} imageId={user.avatarId} size={72} status={user.status} />
          <div>
            <h2 id="profile-h" className="profile-card__name">{displayName || user.username}</h2>
            <p className="muted profile-card__tag">
              <span className="mono">{formatTag(user)}</span>
              <button type="button" className="link" onClick={copyTag}>
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </p>
          </div>
        </div>
      </div>
      <ProfileImageControls />
      <form className="stack" onSubmit={submit}>
        <TextField label="Nome de exibição" value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} />
        <div className="field">
          <label className="field__label" htmlFor="bio">Sobre mim</label>
          <textarea id="bio" className="field__input field__textarea" maxLength={190} value={bio} onChange={(e) => setBio(e.target.value)} />
          <p className="field__hint">{190 - bio.length} caracteres restantes</p>
        </div>
        <p className="field__hint">
          O nome de usuário não pode ser alterado nesta versão. Seu e-mail, IP e dados do dispositivo nunca são exibidos a
          outras pessoas.
        </p>
        {error && <Banner tone="error">{error}</Banner>}
        {ok && !dirty && <Banner tone="success">Perfil atualizado.</Banner>}
        <div className="row-end">
          <Button type="button" variant="ghost" disabled={!dirty || busy} onClick={() => { setDisplayName(user.displayName); setBio(user.bio); }}>
            Descartar
          </Button>
          <Button type="submit" disabled={!dirty} loading={busy}>Salvar perfil</Button>
        </div>
      </form>
    </section>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setOk(false);
    const parsed = changePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return setErrors({ [String(i?.path[0])]: i?.message ?? 'Inválido.' });
    }
    if (next !== confirm) return setErrors({ confirm: 'As senhas não coincidem.' });
    setErrors({});
    setBusy(true);
    try {
      await api.changePassword(parsed.data);
      setOk(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setErrors({ currentPassword: err.message });
      else setErrors({ form: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="pw-h">
      <h2 id="pw-h" className="panel__title">Senha</h2>
      <p className="muted">Ao trocar a senha, todas as outras sessões são encerradas imediatamente.</p>
      <form className="stack" onSubmit={submit}>
        <TextField label="Senha atual" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.currentPassword} />
        <div className="grid-2">
          <TextField label="Nova senha" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={errors.newPassword} />
          <TextField label="Confirmar nova senha" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
        </div>
        {errors.form && <Banner tone="error">{errors.form}</Banner>}
        {ok && <Banner tone="success">Senha alterada. Outras sessões foram encerradas.</Banner>}
        <div className="row-end">
          <Button type="submit" loading={busy} disabled={!current || !next}>Alterar senha</Button>
        </div>
      </form>
    </section>
  );
}

function RecoveryCodes() {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { recoveryCodes } = await api.regenerateRecoveryCodes(password);
      setAsking(false);
      setPassword('');
      useSession.getState().showRecoveryCodes(recoveryCodes);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="rc-h">
      <h2 id="rc-h" className="panel__title">Códigos de recuperação</h2>
      <p className="muted">Gere novos códigos se você perdeu os anteriores. Os antigos deixam de funcionar.</p>
      <div>
        <Button variant="secondary" onClick={() => setAsking(true)}>Gerar novos códigos</Button>
      </div>
      {asking && (
        <Modal
          title="Confirme sua senha"
          size="sm"
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>Cancelar</Button>
              <Button type="submit" form="rc-form" loading={busy} disabled={!password}>Gerar códigos</Button>
            </>
          }
        >
          <form id="rc-form" className="stack" onSubmit={submit}>
            <TextField label="Senha" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error} />
          </form>
        </Modal>
      )}
    </section>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<LoginSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await api.sessions());
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const revoke = async (id: string) => {
    setBusyId(id);
    try {
      await api.revokeSession(id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const revokeAll = async () => {
    setBusyId('all');
    try {
      await api.revokeOtherSessions();
      setConfirmAll(false);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const others = sessions?.filter((s) => !s.current) ?? [];

  return (
    <section className="panel" aria-labelledby="sess-h">
      <h2 id="sess-h" className="panel__title">Sessões ativas</h2>
      <p className="muted">Dispositivos conectados à sua conta. Encerrar uma sessão desconecta o dispositivo na hora.</p>
      {error && <Banner tone="error">{error}</Banner>}
      {!sessions && !error && <Spinner />}
      {sessions && (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id} className="sessions__item">
              <Laptop size={20} aria-hidden />
              <div className="sessions__info">
                <strong>
                  {s.clientName} {s.current && <span className="tag">Esta sessão</span>}
                </strong>
                <span className="muted">
                  Último uso {formatDate(s.lastUsedAt)} · iniciada {formatDate(s.createdAt)}
                </span>
              </div>
              {!s.current && (
                <Button variant="secondary" size="sm" loading={busyId === s.id} onClick={() => revoke(s.id)} aria-label={`Encerrar sessão ${s.clientName}`}>
                  <Trash2 size={14} aria-hidden /> Encerrar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <div>
          <Button variant="danger" onClick={() => setConfirmAll(true)}>Encerrar todas as outras sessões</Button>
        </div>
      )}
      {confirmAll && (
        <Modal
          title="Encerrar outras sessões?"
          size="sm"
          onClose={() => setConfirmAll(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmAll(false)}>Cancelar</Button>
              <Button variant="danger" loading={busyId === 'all'} onClick={revokeAll}>Encerrar {others.length}</Button>
            </>
          }
        >
          <p>{others.length} dispositivo(s) serão desconectados imediatamente e precisarão entrar de novo.</p>
        </Modal>
      )}
    </section>
  );
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
