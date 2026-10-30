import { useEffect, useState } from 'react';
import { RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Button, Tooltip } from './ui';
import { reconnectNow } from '../services/realtime';
import { useConnection } from '../stores/connection';

export function latencyQuality(ms: number | null): 'good' | 'fair' | 'poor' | 'unknown' {
  if (ms == null) return 'unknown';
  if (ms < 120) return 'good';
  if (ms < 300) return 'fair';
  return 'poor';
}

/** Ícone compacto na barra do usuário. */
export function ConnectionIndicator() {
  const { state, latencyMs } = useConnection();
  const connected = state === 'connected';
  const label = connected
    ? `Conectado${latencyMs != null ? ` · ${latencyMs} ms` : ''}`
    : state === 'offline'
      ? 'Sem internet'
      : 'Reconectando…';
  return (
    <Tooltip label={label}>
      <span className={`conn-ind conn-ind--${connected ? latencyQuality(latencyMs) : 'down'}`} role="img" aria-label={label}>
        {connected ? <Wifi size={16} /> : <WifiOff size={16} />}
      </span>
    </Tooltip>
  );
}

/** Faixa no topo da área principal enquanto o tempo real está fora. */
export function ConnectionBanner() {
  const { state, retryAt } = useConnection();
  const [now, setNow] = useState(Date.now());
  const down = state === 'reconnecting' || state === 'offline';

  useEffect(() => {
    if (!down) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [down]);

  if (!down) return null;
  const secs = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null;
  return (
    <div className="conn-banner" role="status">
      <WifiOff size={16} aria-hidden />
      <span>
        {state === 'offline' ? 'Você está sem internet.' : 'Conexão em tempo real perdida.'}
        {secs != null && secs > 0 ? ` Nova tentativa em ${secs}s.` : ' Reconectando…'}
      </span>
      <Button size="sm" variant="secondary" onClick={() => reconnectNow()}>
        <RefreshCw size={14} aria-hidden /> Tentar agora
      </Button>
    </div>
  );
}
