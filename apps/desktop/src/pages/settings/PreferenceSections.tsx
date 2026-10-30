import { useState } from 'react';
import type { UserSettings } from '@nexo/protocol';
import { Monitor, Moon, RefreshCw, Sun } from 'lucide-react';
import { Button, Toggle } from '../../components/ui';
import { latencyQuality } from '../../components/ConnectionIndicator';
import { APP_VERSION, gatewayUrl, getApiUrl, isTauri } from '../../services/platform';
import { reconnectNow } from '../../services/realtime';
import { useConnection } from '../../stores/connection';
import { api, useSession } from '../../stores/session';
import { useSettings } from '../../stores/settings';
import { useSocial } from '../../stores/social';
import { useNav } from '../../stores/nav';
import { useUi } from '../../stores/ui';
import { requestBrowserPermission, testNotification, useNotify } from '../../lib/notify/engine';

function useSetting<K extends keyof UserSettings>(key: K): [UserSettings[K], (v: UserSettings[K]) => void] {
  const value = useSettings((s) => s.settings[key]);
  const update = useSettings((s) => s.update);
  return [value, (v) => update({ [key]: v } as Partial<UserSettings>)];
}

export function AppearanceSection() {
  const [theme, setTheme] = useSetting('theme');
  const [density, setDensity] = useSetting('density');
  const [scale, setScale] = useSetting('uiScale');
  const [lowPower, setLowPower] = useSetting('lowPowerMode');

  const themes = [
    { id: 'dark', label: 'Escuro', icon: <Moon size={18} /> },
    { id: 'light', label: 'Claro', icon: <Sun size={18} /> },
    { id: 'system', label: 'Sistema', icon: <Monitor size={18} /> },
  ] as const;

  return (
    <div className="stack-lg">
      <section className="panel">
        <h2 className="panel__title">Tema</h2>
        <div className="choice-grid" role="radiogroup" aria-label="Tema">
          {themes.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={theme === t.id}
              className={`choice choice--${t.id} ${theme === t.id ? 'choice--on' : ''}`}
              onClick={() => setTheme(t.id)}
            >
              <span className="choice__preview" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <span className="choice__label">
                {t.icon} {t.label}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">Densidade</h2>
        <div className="segmented" role="radiogroup" aria-label="Densidade">
          {(['comfortable', 'compact'] as const).map((d) => (
            <button key={d} role="radio" aria-checked={density === d} className={density === d ? 'segmented__on' : ''} onClick={() => setDensity(d)}>
              {d === 'comfortable' ? 'Confortável' : 'Compacta'}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">Escala da interface</h2>
        <div className="slider-row">
          <input
            type="range"
            min={0.8}
            max={1.5}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            aria-label="Escala da interface"
            aria-valuetext={`${Math.round(scale * 100)}%`}
          />
          <span className="mono">{Math.round(scale * 100)}%</span>
          <Button size="sm" variant="ghost" onClick={() => setScale(1)} disabled={scale === 1}>
            Restaurar
          </Button>
        </div>
      </section>

      <section className="panel">
        <Toggle
          label="Modo de baixo consumo"
          description="Desativa animações e, nas próximas etapas, prioriza a estabilidade da voz reduzindo vídeo e efeitos."
          checked={lowPower}
          onChange={setLowPower}
        />
      </section>

      <div>
        <Button variant="ghost" onClick={() => useSettings.getState().reset()}>
          Restaurar todas as preferências padrão
        </Button>
      </div>
    </div>
  );
}

export function PrivacySection() {
  const [from, setFrom] = useSetting('friendRequestsFrom');
  const [dms, setDms] = useSetting('allowDmsFromServerMembers');
  const blocked = useSocial((s) => Object.values(s.relationships).filter((r) => r.type === 'blocked').length);
  const options = [
    ['everyone', 'Qualquer pessoa'],
    ['server_members', 'Só membros de servidores em comum'],
    ['nobody', 'Ninguém'],
  ] as const;
  return (
    <div className="stack-lg">
      <section className="panel">
        <h2 className="panel__title">Quem pode enviar pedidos de amizade</h2>
        <div className="segmented" role="radiogroup" aria-label="Quem pode enviar pedidos de amizade">
          {options.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={from === id} className={from === id ? 'segmented__on' : ''} onClick={() => setFrom(id)}>
              {label}
            </button>
          ))}
        </div>
        <p className="field__hint">Quem for recusado vê apenas que o pedido não pôde ser enviado — sem saber o motivo.</p>
      </section>
      <section className="panel">
        <Toggle
          label="Permitir mensagens diretas de membros dos meus servidores"
          description="Desligado, só amigos podem iniciar uma conversa privada com você. Bloqueios sempre impedem mensagens."
          checked={dms}
          onChange={setDms}
        />
      </section>
      <section className="panel">
        <h2 className="panel__title">Bloqueios</h2>
        <p className="muted">
          {blocked ? `${blocked} pessoa(s) bloqueada(s).` : 'Você não bloqueou ninguém.'} Pessoas bloqueadas não podem enviar pedidos nem mensagens
          diretas e deixam de ver quando você está online.
        </p>
        <div>
          <Button variant="secondary" onClick={() => { useNav.getState().go({ kind: 'friends' }); useNav.getState().setFriendsTab('blocked'); useUi.getState().closeSettings(); }}>
            Ver bloqueados
          </Button>
        </div>
      </section>
    </div>
  );
}

export function AccessibilitySection() {
  const [reduced, setReduced] = useSetting('reducedMotion');
  const [contrast, setContrast] = useSetting('highContrast');
  return (
    <div className="stack-lg">
      <section className="panel">
        <Toggle label="Reduzir movimento" description="Remove animações e transições. A preferência do Windows também é respeitada." checked={reduced} onChange={setReduced} />
        <Toggle label="Aumentar contraste" description="Textos secundários e bordas ficam mais fortes." checked={contrast} onChange={setContrast} />
      </section>
      <section className="panel">
        <h2 className="panel__title">Navegação por teclado</h2>
        <ul className="kbd-list">
          <li><kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> percorre os controles, sempre com foco visível.</li>
          <li><kbd>Esc</kbd> fecha diálogos e estas configurações.</li>
          <li><kbd>Enter</kbd> ou <kbd>Espaço</kbd> ativa botões e interruptores.</li>
        </ul>
      </section>
    </div>
  );
}

export function NotificationsSection() {
  const [preview, setPreview] = useSetting('showMessagePreviewInNotifications');
  const [tray, setTray] = useSetting('closeToTray');
  const [desktop, setDesktop] = useSetting('notifyDesktop');
  const [sounds, setSounds] = useSetting('notifySounds');
  const [dms, setDms] = useSetting('notifyDms');
  const [mentions, setMentions] = useSetting('notifyMentions');
  const [friends, setFriends] = useSetting('notifyFriendRequests');
  const [serverDefault, setServerDefault] = useSetting('notifyServerDefault');
  const permission = useNotify((s) => s.permission);
  const [test, setTest] = useState<string | null>(null);
  const status = useSession((s) => s.user?.status);

  const runTest = async () => {
    const r = await testNotification();
    setTest(r === 'shown' ? 'Aviso enviado. Se não apareceu, confira as notificações do sistema (Windows: Configurações → Sistema → Notificações).' : 'O navegador não permitiu avisos. Use o botão acima para permitir.');
  };

  return (
    <div className="stack-lg">
      <section className="panel">
        <h2 className="panel__title">Avisos</h2>
        {status === 'dnd' && <p className="banner banner--warning">Seu status está em "Não perturbe": nenhum aviso nem som de mensagem enquanto ele estiver ativo.</p>}
        <Toggle
          label="Avisos do sistema"
          description="Aparecem quando o VYRON não está em foco. Com o app aberto na conversa, nada é avisado."
          checked={desktop}
          onChange={setDesktop}
        />
        {!isTauri() && desktop && (
          <div className="notify-permission">
            {permission === 'granted' && <span className="muted">O navegador permite avisos.</span>}
            {permission === 'default' && (
              <>
                <span className="muted">O navegador ainda não permitiu avisos.</span>
                <Button size="sm" variant="secondary" onClick={() => void requestBrowserPermission()}>
                  Permitir avisos
                </Button>
              </>
            )}
            {permission === 'denied' && <span className="muted">Avisos bloqueados nas permissões do navegador para este site. Libere por lá.</span>}
            {permission === 'unsupported' && <span className="muted">Este navegador não oferece avisos.</span>}
          </div>
        )}
        <Toggle label="Sons de mensagem" checked={sounds} onChange={setSounds} />
        <div className="row">
          <Button size="sm" variant="secondary" onClick={() => void runTest()}>
            Testar aviso
          </Button>
          {test && <span className="field__hint">{test}</span>}
        </div>
      </section>
      <section className="panel">
        <h2 className="panel__title">Avisar sobre</h2>
        <Toggle label="Mensagens diretas" checked={dms} onChange={setDms} />
        <Toggle label="Menções a você" description="Quando alguém escrever @você num servidor." checked={mentions} onChange={setMentions} />
        <Toggle label="Pedidos de amizade" checked={friends} onChange={setFriends} />
        <div className="field">
          <span className="field__label">Mensagens de servidores (padrão)</span>
          <div className="segmented" role="radiogroup" aria-label="Padrão para servidores">
            {(
              [
                ['all', 'Todas'],
                ['mentions', 'Só menções'],
                ['none', 'Nada'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="radio" aria-checked={serverDefault === id} className={serverDefault === id ? 'segmented__on' : ''} onClick={() => setServerDefault(id)}>
                {label}
              </button>
            ))}
          </div>
          <p className="field__hint">Cada servidor e canal pode ser ajustado ou silenciado pelo sino no topo da conversa.</p>
        </div>
      </section>
      <section className="panel">
        <h2 className="panel__title">Privacidade e bandeja</h2>
        <Toggle
          label="Mostrar conteúdo das mensagens nas notificações"
          description="Desligado, o aviso diz apenas quem enviou — útil ao compartilhar a tela."
          checked={preview}
          onChange={setPreview}
        />
        <Toggle
          label="Manter na bandeja do sistema ao fechar a janela"
          description="O VYRON continua recebendo mensagens. Use “Sair do VYRON” no ícone da bandeja para encerrar por completo — isso também encerra chamadas, capturas e sessões remotas."
          checked={tray}
          onChange={setTray}
          disabled={!isTauri()}
        />
        {!isTauri() && <p className="field__hint">Disponível apenas no aplicativo para Windows.</p>}
      </section>
    </div>
  );
}

export function NetworkSection() {
  const { state, latencyMs } = useConnection();
  const sessionId = useSession((s) => s.sessionId);
  const [apiCheck, setApiCheck] = useState<{ ms: number } | { error: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const testApi = async () => {
    setChecking(true);
    const t0 = performance.now();
    try {
      await api.health();
      setApiCheck({ ms: Math.round(performance.now() - t0) });
    } catch (err) {
      setApiCheck({ error: (err as Error).message });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="stack-lg">
      <section className="panel">
        <h2 className="panel__title">Diagnóstico</h2>
        <dl className="diag">
          <dt>Gateway em tempo real</dt>
          <dd>
            <span className={`dot dot--q-${state === 'connected' ? latencyQuality(latencyMs) : 'down'}`} /> {state}
          </dd>
          <dt>Latência (heartbeat)</dt>
          <dd>{latencyMs != null && state === 'connected' ? `${latencyMs} ms` : '—'}</dd>
          <dt>Servidor da API</dt>
          <dd className="mono">{getApiUrl()}</dd>
          <dt>Gateway</dt>
          <dd className="mono">{gatewayUrl()}</dd>
          <dt>Sessão</dt>
          <dd className="mono">{sessionId ? `${sessionId.slice(0, 8)}…` : '—'}</dd>
          <dt>Teste da API</dt>
          <dd>{apiCheck ? ('ms' in apiCheck ? `respondeu em ${apiCheck.ms} ms` : apiCheck.error) : 'não executado'}</dd>
        </dl>
        <div className="row">
          <Button variant="secondary" onClick={testApi} loading={checking}>
            Testar API
          </Button>
          <Button variant="secondary" onClick={() => reconnectNow()} disabled={state === 'connected'}>
            <RefreshCw size={14} aria-hidden /> Reconectar agora
          </Button>
        </div>
        <p className="field__hint">
          A latência é medida pelo tempo de ida e volta do heartbeat do gateway. Diagnóstico de voz (perda de pacotes, jitter) chega
          na Etapa 3.
        </p>
      </section>
    </div>
  );
}

const LICENSES = [
  ['Tauri', 'MIT / Apache-2.0'],
  ['React', 'MIT'],
  ['Zustand', 'MIT'],
  ['Zod', 'MIT'],
  ['Lucide (ícones)', 'ISC'],
  ['Vite', 'MIT'],
  ['RNNoise (Xiph.Org, supressão de ruído)', 'BSD-3-Clause'],
  ['rnnoise-wasm (Shiguredo, build WebAssembly)', 'Apache-2.0'],
  ['web-noise-suppressor (sapphi-red, empacotamento)', 'MIT'],
];

export function AboutSection() {
  return (
    <div className="stack-lg">
      <section className="panel">
        <dl className="diag">
          <dt>Versão</dt>
          <dd className="mono">{APP_VERSION}</dd>
          <dt>Plataforma</dt>
          <dd>{isTauri() ? 'Aplicativo para Windows (Tauri)' : 'Navegador (modo de desenvolvimento)'}</dd>
          <dt>Atualizações</dt>
          <dd>Atualizador assinado previsto para a Etapa 7.</dd>
        </dl>
      </section>
      <section className="panel">
        <h2 className="panel__title">Licenças de terceiros</h2>
        <ul className="licenses">
          {LICENSES.map(([name, lic]) => (
            <li key={name}>
              <span>{name}</span>
              <span className="muted mono">{lic}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
