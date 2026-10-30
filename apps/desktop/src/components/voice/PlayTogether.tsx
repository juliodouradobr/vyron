import { useEffect, useState, type RefObject } from 'react';
import { PLAY_MAX_MINUTES, type PlayControl, type PublicUser } from '@nexo/protocol';
import { Gamepad2, Hand, ShieldAlert, ShieldOff } from 'lucide-react';
import { Banner, Button, Modal } from '../ui';
import { voice } from '../../voice/controller';
import { attachCapture } from '../../voice/play/capture';
import { listTargetWindows, nativeInputAvailable, type TargetWindow } from '../../voice/play/sink';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';

const DURATIONS = [10, 30, 60, PLAY_MAX_MINUTES];

const inputsText = (c: { keyboard: boolean; mouse: boolean }) => [c.keyboard && 'teclado', c.mouse && 'mouse'].filter(Boolean).join(' e ') || 'nada';

/** Minutos restantes até expirar, atualizando a cada 15 s. */
function useMinutesLeft(expiresAt: string | undefined): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000)) : null;
}

/* ===================== Anfitrião ===================== */

/** Aprovar o controle: a pessoa escolhe explicitamente o que libera e por quanto tempo. */
export function PlayGrantDialog({ guest, guestId, onClose }: { guest: PublicUser | undefined; guestId: string; onClose: () => void }) {
  const [keyboard, setKeyboard] = useState(true);
  const [mouse, setMouse] = useState(true);
  const [minutes, setMinutes] = useState(30);
  const native = nativeInputAvailable();
  const [windows, setWindows] = useState<TargetWindow[] | null>(native ? null : []);
  const [target, setTarget] = useState<number | null>(null);

  useEffect(() => {
    if (native) listTargetWindows().then(setWindows, () => setWindows([]));
  }, [native]);

  const name = guest?.displayName ?? 'Essa pessoa';
  const canGrant = (keyboard || mouse) && (!native || target != null);
  const grant = () => {
    const w = windows?.find((x) => x.id === target);
    voice.setPlayWindow(w ? { id: w.id, title: w.title } : null);
    voice.grantPlay(guestId, { keyboard, mouse, minutes });
    onClose();
  };

  return (
    <Modal
      title="Jogar junto"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              voice.declinePlay(guestId);
              onClose();
            }}
          >
            Recusar
          </Button>
          <Button onClick={grant} disabled={!canGrant}>
            Permitir controle
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          <strong>{name}</strong> poderá enviar comandos para {native ? 'a janela escolhida' : 'a sua transmissão'} enquanto você permitir.
          Assistir não dá controle: só o que você marcar abaixo vale.
        </p>
        <fieldset className="stack-sm">
          <legend className="field__label">O que liberar</legend>
          <label className="check">
            <input type="checkbox" checked={keyboard} onChange={(e) => setKeyboard(e.target.checked)} /> Teclado
          </label>
          <label className="check">
            <input type="checkbox" checked={mouse} onChange={(e) => setMouse(e.target.checked)} /> Mouse
          </label>
          <label className="check check--disabled">
            <input type="checkbox" checked={false} disabled /> Controle (gamepad) — ainda não disponível: exige um driver de controle virtual
          </label>
        </fieldset>
        <div className="field">
          <label className="field__label" htmlFor="play-dur">
            Por quanto tempo
          </label>
          <select id="play-dur" className="field__input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d >= 60 ? `${d / 60} hora${d > 60 ? 's' : ''}` : `${d} minutos`}
              </option>
            ))}
          </select>
          <p className="field__hint">Depois disso o controle acaba sozinho. Você pode revogar antes, a qualquer momento.</p>
        </div>
        {native ? (
          <div className="field">
            <label className="field__label" htmlFor="play-win">
              Janela que recebe o controle
            </label>
            <select id="play-win" className="field__input" value={target ?? ''} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Escolha a janela do jogo…</option>
              {windows?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title} ({w.process})
                </option>
              ))}
            </select>
            <p className="field__hint">
              Os comandos só são aplicados enquanto essa janela estiver em primeiro plano. Se você trocar de janela, eles são
              ignorados.
            </p>
          </div>
        ) : (
          <Banner tone="warning">
            Você está usando o VYRON no navegador. Aqui os comandos de {name} <strong>não controlam o seu computador</strong>: eles
            só aparecem para você no monitor de entradas. O controle real exige o aplicativo VYRON para Windows.
          </Banner>
        )}
        <ul className="play-rules">
          <li>Teclas que saem do jogo são bloqueadas: Windows, Alt+Tab, Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc.</li>
          <li>
            <strong>Ctrl+Shift+F12</strong> revoga o controle na hora{native ? ', mesmo com o jogo em primeiro plano' : ' (com o VYRON em foco)'}.
          </li>
          <li>Jogos com anti-cheat podem ignorar ou proibir entrada simulada. O VYRON não contorna isso.</li>
        </ul>
      </div>
    </Modal>
  );
}

/** Pedidos recebidos e, se houver, quem está controlando agora — com revogação sempre à vista. */
export function HostPlayPanel({ users, control }: { users: Map<string, PublicUser>; control: PlayControl | null }) {
  const requests = useVoice((s) => s.playRequests);
  const host = useVoice((s) => s.playHost);
  const [dialog, setDialog] = useState<string | null>(null);
  const left = useMinutesLeft(control?.expiresAt);
  const name = (id: string) => users.get(id)?.displayName ?? 'Alguém';

  return (
    <>
      {requests.map((r) => (
        <div key={r.from} className="play-request" role="status">
          <Gamepad2 size={16} aria-hidden />
          <span>
            <strong>{name(r.from)}</strong> pede para jogar junto.
          </span>
          <Button size="sm" onClick={() => setDialog(r.from)}>
            Ver pedido
          </Button>
          <Button size="sm" variant="secondary" onClick={() => voice.declinePlay(r.from)}>
            Recusar
          </Button>
        </div>
      ))}
      {control && (
        <div className="play-active" role="status">
          <div className="play-active__head">
            <ShieldAlert size={16} aria-hidden />
            <span>
              <strong>{name(control.guestId)}</strong> pode controlar: {inputsText(control)}
              {left != null && <span className="muted"> · termina em {left} min</span>}
              {host?.windowTitle && <span className="muted"> · janela: {host.windowTitle}</span>}
            </span>
            <Button size="sm" variant="danger" onClick={() => voice.revokePlay()}>
              <ShieldOff size={14} aria-hidden /> Revogar agora
            </Button>
          </div>
          <span className="field__hint">Atalho de emergência: Ctrl+Shift+F12.</span>
          {host?.sink === 'monitor' && (
            <Banner tone="info">
              Monitor de entradas: no navegador os comandos <strong>não</strong> controlam o seu computador; eles aparecem aqui
              para você ver exatamente o que chega. O controle real exige o aplicativo para Windows.
            </Banner>
          )}
          {host && (
            <div className="play-monitor">
              <span className="mono">
                {host.accepted} comandos aceitos · {host.blocked} bloqueados
                {host.lastBlock ? ` (último: ${host.lastBlock})` : ''}
              </span>
              {host.sink === 'monitor' && host.recent.length > 0 && (
                <ul aria-label="Últimas entradas recebidas">
                  {host.recent.map((e, i) => (
                    <li key={`${i}-${e}`} className="mono">
                      {e}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {dialog && <PlayGrantDialog guestId={dialog} guest={users.get(dialog)} onClose={() => setDialog(null)} />}
    </>
  );
}

/** Botão do anfitrião para oferecer o controle a quem já assiste (sem esperar um pedido). */
export function OfferControlButton({ guestId, guest }: { guestId: string; guest: PublicUser | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Gamepad2 size={14} aria-hidden /> Dar controle
      </Button>
      {open && <PlayGrantDialog guestId={guestId} guest={guest} onClose={() => setOpen(false)} />}
    </>
  );
}

/* ===================== Convidado ===================== */

/**
 * Barra do convidado na transmissão que está assistindo: pedir, controlar (captura ligada só por
 * escolha dele), devolver. A captura vale apenas sobre a imagem, com o elemento em foco.
 */
export function GuestPlayBar({ hostId, control, area }: { hostId: string; control: PlayControl | null; area: RefObject<HTMLDivElement | null> }) {
  const selfId = useSession((s) => s.user?.id ?? '');
  const pending = useVoice((s) => s.playPending?.hostId === hostId);
  const controlling = useVoice((s) => s.playControlling === hostId);
  const mine = control?.guestId === selfId;
  const left = useMinutesLeft(mine ? control?.expiresAt : undefined);

  useEffect(() => {
    const el = area.current;
    const video = el?.querySelector('video');
    if (!controlling || !mine || !el || !video || !control) return;
    return attachCapture(el, video, (m) => voice.sendInput(hostId, m), { keyboard: control.keyboard, mouse: control.mouse });
  }, [controlling, mine, control, hostId, area]);

  if (control && !mine) return <span className="muted play-guest">Outra pessoa está controlando esta transmissão.</span>;
  if (!mine) {
    return (
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => voice.requestPlay(hostId)}>
        <Gamepad2 size={14} aria-hidden /> {pending ? 'Pedido enviado…' : 'Pedir para jogar'}
      </Button>
    );
  }
  return (
    <span className="play-guest">
      <span className="muted">
        Você pode controlar: {inputsText(control!)}
        {left != null && ` · ${left} min`}
      </span>
      <Button size="sm" variant={controlling ? 'secondary' : 'primary'} onClick={() => voice.setControlling(controlling ? null : hostId)}>
        <Hand size={14} aria-hidden /> {controlling ? 'Parar de controlar' : 'Controlar'}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => voice.releasePlay(hostId)}>
        Devolver
      </Button>
    </span>
  );
}
