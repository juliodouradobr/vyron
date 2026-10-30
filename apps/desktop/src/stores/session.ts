import { create } from 'zustand';
import type { AuthResponse, LoginInput, RecoveryInput, RegisterInput, SelfUser } from '@nexo/protocol';
import { ApiError, createApiClient } from '../services/api';
import { clientName } from '../services/platform';
import { tokenStore } from '../services/tokenStore';

export type SessionPhase = 'booting' | 'signedOut' | 'signedIn' | 'unreachable';
export type SignedOutReason = 'expired' | 'revoked' | 'loggedOut' | null;

interface SessionState {
  phase: SessionPhase;
  user: SelfUser | null;
  token: string | null;
  sessionId: string | null;
  signedOutReason: SignedOutReason;
  /** Códigos exibidos uma única vez logo após o cadastro ou ao gerar novos. */
  pendingRecoveryCodes: string[] | null;

  boot(): Promise<void>;
  login(input: Omit<LoginInput, 'clientName'>): Promise<void>;
  register(input: Omit<RegisterInput, 'clientName'>): Promise<void>;
  recover(input: Omit<RecoveryInput, 'clientName'>): Promise<void>;
  logout(): Promise<void>;
  endSession(reason: Exclude<SignedOutReason, null>): Promise<void>;
  setUser(user: SelfUser): void;
  setSessionId(id: string): void;
  showRecoveryCodes(codes: string[] | null): void;
}

export const useSession = create<SessionState>((set, get) => {
  const signIn = async (res: AuthResponse) => {
    await tokenStore.set(res.token);
    set({ phase: 'signedIn', user: res.user, token: res.token, signedOutReason: null });
  };

  return {
    phase: 'booting',
    user: null,
    token: null,
    sessionId: null,
    signedOutReason: null,
    pendingRecoveryCodes: null,

    /** Restaura a sessão salva. Sem rede, mantém o token e oferece tentar de novo. */
    async boot() {
      set({ phase: 'booting' });
      const token = await tokenStore.get().catch(() => null);
      if (!token) return set({ phase: 'signedOut' });
      set({ token });
      try {
        const user = await api.me();
        set({ phase: 'signedIn', user });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return; // endSession já foi chamado
        set({ phase: 'unreachable' });
      }
    },

    async login(input) {
      await signIn(await api.login({ ...input, clientName: clientName() }));
    },

    async register(input) {
      const res = await api.register({ ...input, clientName: clientName() });
      set({ pendingRecoveryCodes: res.recoveryCodes });
      await signIn(res);
    },

    async recover(input) {
      await signIn(await api.recover({ ...input, clientName: clientName() }));
    },

    async logout() {
      try {
        await api.logout();
      } catch {
        /* mesmo sem rede, o token local é descartado; o servidor expira a sessão depois */
      }
      await get().endSession('loggedOut');
    },

    async endSession(reason) {
      if (get().phase === 'signedOut') return;
      await tokenStore.clear().catch(() => {});
      set({ phase: 'signedOut', user: null, token: null, sessionId: null, signedOutReason: reason, pendingRecoveryCodes: null });
    },

    setUser: (user) => set({ user }),
    setSessionId: (sessionId) => set({ sessionId }),
    showRecoveryCodes: (codes) => set({ pendingRecoveryCodes: codes }),
  };
});

export const api = createApiClient({
  getToken: () => useSession.getState().token,
  onUnauthorized: (code) => void useSession.getState().endSession(code === 'SESSION_EXPIRED' ? 'expired' : 'revoked'),
});
