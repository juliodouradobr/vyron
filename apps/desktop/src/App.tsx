import { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { Button, Logo, Spinner } from './components/ui';
import { AppShell } from './layouts/AppShell';
import { AuthPage } from './pages/AuthPage';
import { useSession } from './stores/session';

export function App() {
  const phase = useSession((s) => s.phase);

  useEffect(() => {
    void useSession.getState().boot();
  }, []);

  if (phase === 'booting') {
    return (
      <div className="boot">
        <div className="boot__inner">
          <span className="boot__logo">
            <Logo size={56} />
          </span>
          <Spinner label="Restaurando sua sessão" />
        </div>
      </div>
    );
  }

  if (phase === 'unreachable') {
    return (
      <div className="boot">
        <div className="boot__inner" role="alert">
          <WifiOff size={40} aria-hidden />
          <h1>Não foi possível alcançar o servidor</h1>
          <p>Sua sessão continua salva. Verifique a conexão com a internet e tente novamente.</p>
          <div className="row">
            <Button onClick={() => void useSession.getState().boot()}>Tentar novamente</Button>
            <Button variant="ghost" onClick={() => void useSession.getState().endSession('loggedOut')}>
              Entrar com outra conta
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return phase === 'signedIn' ? <AppShell /> : <AuthPage />;
}
