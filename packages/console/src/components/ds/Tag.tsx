import * as React from 'react';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Selected/active facet. @default false */
  active?: boolean;
  /** CSS color for a leading swatch (e.g. a topology node color). */
  swatch?: string;
  /** When provided, renders a dismiss control. */
  onRemove?: (e: React.MouseEvent) => void;
}

/** Tag — a filter / facet chip. Optional color swatch and dismiss control. */
export function Tag({ active = false, swatch, onRemove, onClick, className = '', children, ...rest }: TagProps) {
  const interactive = !!onClick;
  const cls = ['mx-tag', active ? 'mx-tag--active' : '', interactive ? 'mx-tag--button' : '', className]
    .filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? active : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e as unknown as React.MouseEvent<HTMLSpanElement>); } } : undefined}
      {...rest}
    >
      {swatch ? <span className="mx-tag__swatch" style={{ '--_c': swatch } as React.CSSProperties} /> : null}
      {children}
      {onRemove ? (
        <span
          className="mx-tag__close"
          role="button"
          tabIndex={0}
          aria-label="Remove"
          onClick={(e) => { e.stopPropagation(); onRemove(e); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove(e as unknown as React.MouseEvent); } }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </span>
      ) : null}
    </span>
  );
}
