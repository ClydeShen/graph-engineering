import * as React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Status encoding. @default "neutral" */
  tone?: 'ok' | 'danger' | 'warn' | 'info' | 'neutral';
  /** Filled instead of outlined. @default false */
  solid?: boolean;
  /** Show a leading status dot. @default false */
  dot?: boolean;
}

/** Badge — a status legend chip. Encodes scope / engine state. */
export function Badge({ tone = 'neutral', solid = false, dot = false, className = '', children, ...rest }: BadgeProps) {
  const cls = ['mx-badge', `mx-badge--${tone}`, solid ? 'mx-badge--solid' : '', className]
    .filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {dot ? <span className="mx-badge__dot" /> : null}
      {children}
    </span>
  );
}
