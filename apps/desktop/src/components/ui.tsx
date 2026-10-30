import { useFileUrl } from '../lib/files';
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Loader2, X } from 'lucide-react';

/* ---------------- Button ---------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, block, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`btn btn--${variant} btn--${size} ${block ? 'btn--block' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Loader2 className="spin" size={16} aria-hidden />}
      <span className={loading ? 'btn__label--loading' : undefined}>{children}</span>
    </button>
  );
});

/* ---------------- IconButton com tooltip ---------------- */

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, danger, tooltipSide = 'top', className = '', children, ...rest },
  ref,
) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        ref={ref}
        aria-label={label}
        className={`icon-btn ${active ? 'icon-btn--active' : ''} ${danger ? 'icon-btn--danger' : ''} ${className}`}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

/* ---------------- Tooltip ---------------- */

/**
 * Dica flutuante. Renderizada no <body> com posição fixa: não aumenta a área rolável de nenhum
 * contêiner, não é cortada por `overflow` e é empurrada para dentro da janela nas bordas.
 */
export function Tooltip({ label, side = 'top', children }: { label: string; side?: 'top' | 'right' | 'bottom'; children: ReactNode }) {
  const host = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !anchor) return;
    const GAP = 8;
    const MARGIN = 6;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left: number;
    let top: number;
    if (side === 'right') {
      left = anchor.right + GAP + 6;
      top = anchor.top + anchor.height / 2 - h / 2;
    } else {
      left = anchor.left + anchor.width / 2 - w / 2;
      top = side === 'top' ? anchor.top - h - GAP : anchor.bottom + GAP;
      // Sem espaço em cima: abre embaixo (e vice-versa).
      if (side === 'top' && top < MARGIN) top = anchor.bottom + GAP;
      if (side === 'bottom' && top + h > innerHeight - MARGIN) top = anchor.top - h - GAP;
    }
    left = Math.max(MARGIN, Math.min(left, innerWidth - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, innerHeight - h - MARGIN));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  }, [anchor, side, label]);

  const show = () => host.current && setAnchor(host.current.getBoundingClientRect());
  const hide = () => setAnchor(null);

  return (
    <span ref={host} className="tooltip-host" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onMouseDown={hide}>
      {children}
      {anchor &&
        createPortal(
          <span ref={tip} role="tooltip" className="tooltip" style={{ visibility: 'hidden' }}>
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}

/* ---------------- TextField ---------------- */

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
  hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, type = 'text', id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [reveal, setReveal] = useState(false);
  const isPassword = type === 'password';
  const describedBy = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label htmlFor={inputId} className="field__label">
        {label}
      </label>
      <div className="field__control">
        <input
          ref={ref}
          id={inputId}
          type={isPassword && reveal ? 'text' : type}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
          className="field__input"
          spellCheck={false}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            className="field__reveal"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? 'Ocultar senha' : 'Mostrar senha'}
          >
            {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-err`} className="field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/* ---------------- Toggle ---------------- */

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`toggle-row ${disabled ? 'toggle-row--disabled' : ''}`}>
      <div>
        <label htmlFor={id} className="toggle-row__label">
          {label}
        </label>
        {description && <p className="toggle-row__desc">{description}</p>}
      </div>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`switch ${checked ? 'switch--on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

/* ---------------- Avatar ---------------- */

const AVATAR_HUES = [168, 200, 255, 285, 320, 15, 35, 95];

function hueFor(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}

export type PresenceDot = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';

export function Avatar({
  name,
  seed,
  size = 32,
  status,
  imageId,
}: {
  name: string;
  seed: string;
  size?: number;
  status?: PresenceDot;
  /** Foto enviada pela pessoa; sem ela (ou enquanto carrega), mostra as iniciais. */
  imageId?: string | null;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '')
    .join('');
  const hue = hueFor(seed);
  const { url } = useFileUrl(imageId);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {url ? (
        <img className="avatar__img avatar__photo" src={url} alt="" draggable={false} />
      ) : (
        <span className="avatar__img" style={{ background: `hsl(${hue} 55% 38%)`, color: `hsl(${hue} 90% 92%)` }}>
          {initials || '?'}
        </span>
      )}
      {status && <span className={`avatar__status status--${status === 'invisible' ? 'offline' : status}`} />}
    </span>
  );
}

/* ---------------- Modal ---------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'full';
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, dismissible ? onClose : undefined);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => dismissible && e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`modal modal--${size}`}>
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          {dismissible && (
            <button className="icon-btn" aria-label="Fechar" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Mantém o foco dentro do diálogo, fecha com Esc e devolve o foco ao elemento anterior. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onEscape?: () => void) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (n) => !n.hasAttribute('disabled'),
      );
    (focusables().find((n) => n.tagName === 'INPUT') ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escRef.current) {
        e.stopPropagation();
        escRef.current();
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el?.addEventListener('keydown', onKey);
    return () => {
      el?.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [ref]);
}

/* ---------------- Diversos ---------------- */

export function Spinner({ size = 20, label = 'Carregando' }: { size?: number; label?: string }) {
  return (
    <span role="status" className="spinner-wrap">
      <Loader2 className="spin" size={size} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Banner({ tone, children }: { tone: 'error' | 'warning' | 'info' | 'success'; children: ReactNode }) {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {/* Um bloco só: texto com <strong>/links no meio não pode virar colunas do flex. */}
      <div className="banner__body">{children}</div>
    </div>
  );
}

/** Marca do VYRON: um "V" em chevron (velocidade, direção) dentro de um hexágono (estrutura, time). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2.5l11.7 6.75v13.5L16 29.5 4.3 22.75V9.25z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M9.5 10.5l6.5 12 6.5-12" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
