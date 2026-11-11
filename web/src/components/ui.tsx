import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const P = (d: string) => (props: any) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {d.split('|').map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);
export const Icon = {
  today: P('M12 3v2|M12 19v2|M3 12h2|M19 12h2|M5.6 5.6l1.4 1.4|M17 17l1.4 1.4|M5.6 18.4 7 17|M17 7l1.4-1.4|M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'),
  calendar: P('M4 6h16v14H4z|M4 10h16|M8 3v4|M16 3v4'),
  target: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'),
  wallet: P('M3 7h18v13H3z|M3 7l3-4h12l3 4|M16 13.5h2'),
  plus: P('M12 5v14|M5 12h14'),
  close: P('M6 6l12 12|M18 6 6 18'),
  check: P('M5 12.5l4.5 4.5L19 7'),
  chat: P('M4 5h16v11H8l-4 4z'),
  camera: P('M4 8h3l2-3h6l2 3h3v11H4z|M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'),
  send: P('M4 12l16-8-6 16-2-7z'),
  grip: P('M9 5v.01|M9 12v.01|M9 19v.01|M15 5v.01|M15 12v.01|M15 19v.01'),
  chevronL: P('M15 6l-6 6 6 6'),
  chevronR: P('M9 6l6 6-6 6'),
  star: P('M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'),
  shuffle: P('M4 7h3c4 0 6 10 10 10h3|M4 17h3c1.5 0 2.7-1.4 3.7-3|M14 7h6|M17 4l3 3-3 3|M17 14l3 3-3 3'),
  settings: P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-.9c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'),
  bell: P('M6 16V11a6 6 0 1 1 12 0v5l2 2H4z|M10 21h4'),
  upload: P('M12 16V4|M7 9l5-5 5 5|M4 20h16'),
  trash: P('M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13'),
  edit: P('M4 20h4L19 9l-4-4L4 16z'),
  clock: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2'),
  repeat: P('M4 12a8 8 0 0 1 14-5l2 2|M20 4v5h-5|M20 12a8 8 0 0 1-14 5l-2-2|M4 20v-5h5'),
  pin: P('M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z|M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  logout: P('M15 4h4v16h-4|M10 8l-4 4 4 4|M6 12h10'),
};

export function Sheet({ title, onClose, children, footer, tall, labelledBy }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; tall?: boolean; labelledBy?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${tall ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : labelledBy}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon.close />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

type Toast = { id: number; text: string };
const ToastCtx = createContext<(text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const n = useRef(0);
  const push = useCallback((text: string) => {
    const id = ++n.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-zone" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Progress({ percent, tone }: { percent: number; tone?: 'over' | 'warn' }) {
  return (
    <div className={`progress${tone ? ' ' + tone : ''}`} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, full, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; full?: boolean; label?: string }) {
  return (
    <div className={`seg${full ? ' full' : ''}`} role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Check({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className={`check${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} onClick={onToggle}>
      {on && <Icon.check />}
    </button>
  );
}
