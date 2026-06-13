import * as React from 'react';

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** State color. @default "idle" */
  tone?: 'ok' | 'danger' | 'warn' | 'info' | 'idle';
  /** Emit a radar ping animation. @default false */
  live?: boolean;
}

/** StatusDot — a live state indicator with optional radar ping. */
export function StatusDot({ tone = 'idle', live = false, children, className = '', ...rest }: StatusDotProps) {
  const cls = ['mx-status', `mx-status--${tone}`, className].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      <span className={`mx-status__dot ${live ? 'mx-status__dot--live' : ''}`} />
      {children ? <span className="mx-status__label">{children}</span> : null}
    </span>
  );
}
