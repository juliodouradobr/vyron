import { useEffect, useState, type FormEvent } from 'react';
import { loginSchema, recoverySchema, registerSchema } from '@nexo/protocol';
import type { ZodTypeAny } from 'zod';
import { Banner, Button, Logo, TextField } from '../components/ui';
import { ApiError, describeError } from '../services/api';
import { getApiUrl, normalizeServerUrl, serverLabel, setApiUrl } from '../services/platform';
import { api, useSession, type SignedOutReason } from '../stores/session';

type Mode = 'login' | 'register' | 'recover';
type FieldErrors = Record<string, string>;

const REASON_TEXT: Record<Exclude<SignedOutReason, null>, string | null> = {
  expired: 'Sua sessão expirou. Entre novamente para continuar.',
  revoked: 'Sua sessão foi encerrada (por outro dispositivo ou troca de senha).',
  loggedOut: null,
};

/** Converte erros do zod em mensagens por campo. */
function validate(schema: ZodTypeAny, data: unknown): FieldErrors | null {
  const r = schema.safeParse(data);
  if (r.success) return null;
  const errs: FieldErrors = {};
  for (const i of r.error.issues) {
    const key = String(i.path[0] ?? 'form');
    errs[key] ??= i.message;
  }
  return errs;
}

export function AuthPage() {
  const reason = useSession((s) => s.signedOutReason);
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<'checking' | 'up' | 'down'>('checking');

  const checkServer = () => {
    setServer('checking');
    api.health().then(
      () => setServer('up'),
      () => setServer('down'),
    );
  };
  useEffect(checkServer, []);

  const [editingServer, setEditingServer] = useState(false);
  const [serverInput, setServerInput] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverBusy, setServerBusy] = useState(false);

  /** Só troca de servidor depois de confirmar que no endereço há mesmo um servidor VYRON respondendo. */
  async function saveServer(e: FormEvent) {
    e.preventDefault();
    const n = normalizeServerUrl(serverInput);
    if ('error' in n) return setServerError(n.error);
    setServerBusy(true);
    setServerError(null);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${n.url}/api/v1/health`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || body?.ok !== true) throw new Error('não é VYRON');
      setApiUrl(n.url);
      setEditingServer(false);
      setFormError(null);
      checkServer();
    } catch {
      setServerError('Não encontramos um servidor VYRON nesse endereço. Confira o endereço e se o servidor está no ar.');
    } finally {
      setServerBusy(false);
    }
  }

  const switchMode = (m: Mode) => {
    setMode(m);
    setErrors({});
    setFormError(null);
    setPassword('');
    setConfirm('');
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const session = useSession.getState();

    let errs: FieldErrors | null = null;
    if (mode === 'login') errs = validate(loginSchema, { username, password });
    if (mode === 'register') {
      errs = validate(registerSchema, { username, password, displayName: displayName || undefined });
      if (!errs && password !== confirm) errs = { confirm: 'As senhas não coincidem.' };
    }
    if (mode === 'recover') {
      errs = validate(recoverySchema, { username, recoveryCode: code, newPassword: password });
      if (!errs && password !== confirm) errs = { confirm: 'As senhas não coincidem.' };
    }
    setErrors(errs ?? {});
    if (errs) return;

    setBusy(true);
    try {
      if (mode === 'login') await session.login({ username, password });
      if (mode === 'register') await session.register({ username, password, displayName: displayName || undefined });
      if (mode === 'recover') await session.recover({ username, recoveryCode: code, newPassword: password });
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  function handleError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError(describeError(err));
    switch (err.code) {
      case 'USERNAME_TAKEN':
      case 'UNKNOWN_ACCOUNT':
      case 'AMBIGUOUS_USERNAME':
        return setErrors({ username: err.message });
      case 'INVALID_CREDENTIALS':
        return setErrors({ password: err.message });
      case 'INVALID_RECOVERY_CODE':
        return setErrors({ recoveryCode: err.message });
      case 'VALIDATION': {
        const d = err.details?.[0];
        if (d) return setErrors({ [d.path.split('.')[0] || 'form']: d.message });
        return setFormError(err.message);
      }
      case 'NETWORK':
      case 'TIMEOUT':
        setServer('down');
        return setFormError(`${err.message} Verifique sua conexão ou se o servidor está no ar.`);
      default:
        return setFormError(describeError(err));
    }
  }

  const title = { login: 'Que bom te ver de novo', register: 'Criar uma conta', recover: 'Recuperar acesso' }[mode];
  const subtitle = {
    login: 'Entre para voltar às suas comunidades.',
    register: 'Escolha um nome. O VYRON adiciona um número e forma seu identificador, como Nome#04821.',
    recover: 'Use um dos códigos de recuperação que você guardou ao criar a conta.',
  }[mode];

  return (
    <div className="auth">
      <div className="auth__backdrop" aria-hidden />
      <main className="auth__card">
        <div className="auth__brand">
          <Logo size={36} />
          <span>VYRON</span>
          <span className="auth__slogan">Sua voz. Seu time. Seu jogo.</span>
        </div>
        <h1 className="auth__title">{title}</h1>
        <p className="auth__subtitle">{subtitle}</p>

        {reason && REASON_TEXT[reason] && mode === 'login' && <Banner tone="warning">{REASON_TEXT[reason]}</Banner>}
        {formError && <Banner tone="error">{formError}</Banner>}

        <form className="auth__form" onSubmit={onSubmit} noValidate>
          <TextField
            label={mode === 'register' ? 'Nome' : 'Identificador'}
            autoComplete="username"
            autoFocus
            placeholder={mode === 'register' ? undefined : 'Nome#00000'}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={errors.username}
            hint={
              mode === 'register'
                ? 'Letras, números, "_", "." ou "-", sem espaços. Outras pessoas podem ter o mesmo nome.'
                : 'Se só você usa esse nome, o número é opcional.'
            }
            maxLength={mode === 'register' ? 32 : 40}
          />
          {mode === 'register' && (
            <TextField
              label="Nome de exibição (opcional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={errors.displayName}
              maxLength={32}
            />
          )}
          {mode === 'recover' && (
            <TextField
              label="Código de recuperação"
              className="mono"
              placeholder="XXXXX-XXXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={errors.recoveryCode}
              maxLength={11}
              autoComplete="one-time-code"
            />
          )}
          <TextField
            label={mode === 'recover' ? 'Nova senha' : 'Senha'}
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password ?? errors.newPassword}
            hint={mode !== 'login' ? 'Mínimo de 8 caracteres. Frases longas são ótimas senhas.' : undefined}
            maxLength={128}
          />
          {mode !== 'login' && (
            <TextField
              label="Confirmar senha"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={errors.confirm}
              maxLength={128}
            />
          )}
          {mode === 'login' && (
            <button type="button" className="link auth__forgot" onClick={() => switchMode('recover')}>
              Esqueceu a senha?
            </button>
          )}
          <Button type="submit" size="lg" block loading={busy}>
            {mode === 'login' ? 'Entrar' : mode === 'register' ? 'Criar conta' : 'Redefinir senha e entrar'}
          </Button>
        </form>

        <p className="auth__switch">
          {mode === 'login' ? (
            <>
              Ainda não tem conta?{' '}
              <button type="button" className="link" onClick={() => switchMode('register')}>
                Cadastre-se
              </button>
            </>
          ) : (
            <>
              Já tem conta?{' '}
              <button type="button" className="link" onClick={() => switchMode('login')}>
                Entrar
              </button>
            </>
          )}
        </p>

        {editingServer ? (
          <form className="auth__server-form" onSubmit={saveServer} noValidate>
            <TextField
              label="Endereço do servidor VYRON"
              placeholder="vyron.exemplo.com"
              autoFocus
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
              error={serverError ?? undefined}
              hint="Peça o endereço a quem administra o servidor. A conexão é sempre criptografada (HTTPS)."
              maxLength={200}
              spellCheck={false}
            />
            <div className="row">
              <Button type="button" variant="secondary" onClick={() => setEditingServer(false)}>
                Cancelar
              </Button>
              <Button type="submit" loading={serverBusy}>
                Conectar
              </Button>
            </div>
          </form>
        ) : (
          <footer className="auth__server" aria-live="polite">
            <span className={`dot dot--${server}`} />
            <span className="auth__server-name mono" title={getApiUrl()}>
              {serverLabel()}
            </span>
            <span>
              {server === 'checking' && '· verificando…'}
              {server === 'up' && '· disponível'}
              {server === 'down' && (
                <>
                  · inacessível ·{' '}
                  <button type="button" className="link" onClick={checkServer}>
                    tentar de novo
                  </button>
                </>
              )}
            </span>
            <button
              type="button"
              className="link auth__server-change"
              onClick={() => {
                setServerInput(serverLabel());
                setServerError(null);
                setEditingServer(true);
              }}
            >
              Trocar servidor
            </button>
          </footer>
        )}
      </main>
    </div>
  );
}
