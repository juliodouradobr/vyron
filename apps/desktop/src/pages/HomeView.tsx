import { formatTag } from '@nexo/protocol';
import { Activity, CheckCircle2, Circle, House, KeyRound, Menu, MonitorSmartphone, Palette, UserRound } from 'lucide-react';
import { Avatar, IconButton } from '../components/ui';
import { ConnectionBanner, latencyQuality } from '../components/ConnectionIndicator';
import { STATUS_LABEL } from '../components/UserPanel';
import { useConnection } from '../stores/connection';
import { useSession } from '../stores/session';
import { useUi, type SettingsSection } from '../stores/ui';

const STAGES: Array<{ title: string; desc: string; done: boolean }> = [
  { title: 'Fundação', desc: 'Contas, sessões seguras, tempo real e interface principal', done: true },
  { title: 'Social', desc: 'Amigos, mensagens diretas, servidores, canais e cargos', done: true },
  { title: 'Voz', desc: 'Canais de voz e chamadas com baixa latência', done: true },
  { title: 'Supressão de ruído', desc: 'Filtro neural local, com modos ajustáveis', done: true },
  { title: 'Transmissão', desc: 'Compartilhar tela, janela ou jogo', done: true },
  { title: 'Jogar Juntos', desc: 'Sessões remotas com aprovação e permissões', done: false },
  { title: 'Acabamento', desc: 'Notificações, bandeja, instalador e atualizações', done: false },
];

const CONN_TEXT = {
  idle: 'Desconectado',
  connecting: 'Conectando…',
  connected: 'Conectado',
  reconnecting: 'Reconectando…',
  offline: 'Sem internet',
} as const;

export function HomeView() {
  const user = useSession((s) => s.user)!;
  const { state, latencyMs } = useConnection();
  const openSettings = useUi((s) => s.openSettings);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const quality = state === 'connected' ? latencyQuality(latencyMs) : 'down';

  return (
    <main className="main" aria-label="Início">
      <header className="main__header">
        <IconButton label="Abrir conversas" className="main__menu" onClick={() => toggleSidebar(true)} tooltipSide="bottom">
          <Menu size={20} />
        </IconButton>
        <House size={20} className="main__header-icon" aria-hidden />
        <h1>Início</h1>
      </header>
      <ConnectionBanner />

      <div className="main__scroll">
        <section className="hero">
          <Avatar name={user.displayName} seed={user.id} imageId={user.avatarId} size={64} status={user.status} />
          <div>
            <h2 className="hero__title">Olá, {user.displayName}</h2>
            <p className="hero__subtitle">
              {formatTag(user)} ·{STATUS_LABEL[user.status]} · membro desde{' '}
              {new Date(user.createdAt).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
            </p>
          </div>
        </section>

        <div className="cards">
          <section className="card" aria-labelledby="card-conn">
            <h3 id="card-conn" className="card__title">
              <Activity size={16} aria-hidden /> Conexão
            </h3>
            <dl className="stats">
              <div>
                <dt>Tempo real</dt>
                <dd>
                  <span className={`dot dot--q-${quality}`} /> {CONN_TEXT[state]}
                </dd>
              </div>
              <div>
                <dt>Latência</dt>
                <dd>{state === 'connected' && latencyMs != null ? `${latencyMs} ms` : '—'}</dd>
              </div>
            </dl>
            <button className="link card__link" onClick={() => openSettings('network')}>
              Ver diagnóstico
            </button>
          </section>

          <section className="card" aria-labelledby="card-account">
            <h3 id="card-account" className="card__title">
              <UserRound size={16} aria-hidden /> Sua conta
            </h3>
            <ul className="quick">
              <QuickLink icon={<UserRound size={16} />} label="Editar perfil" section="account" />
              <QuickLink icon={<MonitorSmartphone size={16} />} label="Sessões ativas" section="account" />
              <QuickLink icon={<KeyRound size={16} />} label="Senha e códigos de recuperação" section="account" />
              <QuickLink icon={<Palette size={16} />} label="Tema e aparência" section="appearance" />
            </ul>
          </section>
        </div>

        <section className="card card--wide" aria-labelledby="card-roadmap">
          <h3 id="card-roadmap" className="card__title">
            O que já funciona e o que vem a seguir
          </h3>
          <ol className="roadmap">
            {STAGES.map((s, i) => (
              <li key={s.title} className={s.done ? 'roadmap__item roadmap__item--done' : 'roadmap__item'}>
                {s.done ? <CheckCircle2 size={18} aria-hidden /> : <Circle size={18} aria-hidden />}
                <span className="roadmap__n">Etapa {i + 1}</span>
                <strong>{s.title}</strong>
                <span className="roadmap__desc">{s.desc}</span>
                <span className="sr-only">{s.done ? 'concluída' : 'pendente'}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}

function QuickLink({ icon, label, section }: { icon: React.ReactNode; label: string; section: SettingsSection }) {
  const openSettings = useUi((s) => s.openSettings);
  return (
    <li>
      <button className="quick__btn" onClick={() => openSettings(section)}>
        {icon}
        {label}
      </button>
    </li>
  );
}
