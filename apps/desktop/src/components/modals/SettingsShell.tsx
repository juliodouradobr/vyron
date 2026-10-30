import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../ui';

export interface ShellSection<T extends string> {
  id: T;
  label: string;
  hidden?: boolean;
}

/** Layout de tela cheia compartilhado pelas configurações de servidor e de canal. */
export function SettingsShell<T extends string>({
  title,
  sections,
  current,
  onSelect,
  onClose,
  footer,
  children,
}: {
  title: string;
  sections: Array<ShellSection<T>>;
  current: T;
  onSelect: (id: T) => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  const active = sections.find((s) => s.id === current);
  return (
    <div ref={ref} className="settings" role="dialog" aria-modal="true" aria-label={title}>
      <nav className="settings__nav" aria-label={`Seções de ${title}`}>
        <div className="settings__nav-inner">
          <div className="settings__group">
            <h2 className="settings__group-title">{title}</h2>
            {sections
              .filter((s) => !s.hidden)
              .map((s) => (
                <button
                  key={s.id}
                  className={`settings__nav-item ${s.id === current ? 'settings__nav-item--active' : ''}`}
                  aria-current={s.id === current ? 'page' : undefined}
                  onClick={() => onSelect(s.id)}
                >
                  <span>{s.label}</span>
                </button>
              ))}
          </div>
          {footer && <div className="settings__group">{footer}</div>}
        </div>
      </nav>
      <section className="settings__content" aria-labelledby="sub-settings-title">
        <div className="settings__content-inner">
          <header className="settings__head">
            <h1 id="sub-settings-title">{active?.label}</h1>
          </header>
          {children}
        </div>
        <div className="settings__close">
          <button className="settings__close-btn" onClick={onClose} aria-label={`Fechar ${title}`}>
            <X size={18} />
          </button>
          <span aria-hidden>ESC</span>
        </div>
      </section>
    </div>
  );
}

/** Seletor de três estados para um ajuste de permissão de canal. */
export function TriState({ value, onChange, disabled, label }: { value: -1 | 0 | 1; onChange: (v: -1 | 0 | 1) => void; disabled?: boolean; label: string }) {
  const opts: Array<[-1 | 0 | 1, string, string]> = [
    [-1, '✕', 'Negar'],
    [0, '/', 'Herdar'],
    [1, '✓', 'Permitir'],
  ];
  return (
    <div className="tristate" role="radiogroup" aria-label={label}>
      {opts.map(([v, sym, name]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          aria-label={name}
          title={name}
          disabled={disabled}
          className={`tristate__btn tristate__btn--${v === -1 ? 'deny' : v === 1 ? 'allow' : 'neutral'} ${value === v ? 'tristate__btn--on' : ''}`}
          onClick={() => onChange(v)}
        >
          {sym}
        </button>
      ))}
    </div>
  );
}
