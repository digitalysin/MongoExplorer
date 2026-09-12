import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'default' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

export function Button({ variant = 'default', size = 'md', className, ...rest }: ButtonProps) {
  return <button className={`btn btn-${variant} btn-${size} ${className ?? ''}`} {...rest} />;
}

export function Field({
  label,
  hint,
  children,
  wide
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/**
 * Friction on purpose: typing the name of the thing being destroyed is the one
 * confirmation people cannot click through on autopilot.
 */
export function TypeToConfirm({
  word,
  value,
  onChange
}: {
  word: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field type-to-confirm">
      <span className="field-label">
        Type <span className="mono">{word}</span> to confirm
      </span>
      <input
        className="input"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={word}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${props.className ?? ''}`} />;
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`checkbox ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 640
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * A determinate bar when the share is known, and a sliding one when it is not —
 * a job whose size nobody can count still has to look alive.
 */
export function ProgressBar({ fraction }: { fraction: number | null }) {
  if (fraction === null) {
    return (
      <div className="progress is-indeterminate" role="progressbar">
        <span />
      </div>
    );
  }
  const percent = Math.min(100, Math.max(0, fraction * 100));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

export interface MenuItem {
  /** A divider; every other field is ignored. */
  separator?: boolean;
  label?: ReactNode;
  /** Shortcut or type shown right-aligned. */
  hint?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * A right-click menu anchored to the pointer. It closes on the next click,
 * Escape, scroll or resize — anything that would leave it pointing at a row
 * that has moved.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y, measured: false });

  // Measure first, then nudge the menu back inside the window.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    setPosition({
      x: Math.max(6, Math.min(x, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - height - 6)),
      measured: true
    });
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: position.x, top: position.y, visibility: position.measured ? 'visible' : 'hidden' }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`separator-${index}`} className="context-menu-separator" />
        ) : (
          <button
            key={`item-${index}`}
            type="button"
            role="menuitem"
            className={`context-menu-item ${item.danger ? 'is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            <span className="context-menu-label">{item.label}</span>
            {item.hint ? <span className="context-menu-hint">{item.hint}</span> : null}
          </button>
        )
      )}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
