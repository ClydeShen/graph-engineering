import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual role. primary = brass signal CTA. @default "secondary" */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to full container width. @default false */
  block?: boolean;
  /** Icon node placed before the label. */
  iconLeft?: React.ReactNode;
  /** Icon node placed after the label. */
  iconRight?: React.ReactNode;
}

/**
 * Button — the primary mechanical control.
 * Variants: primary (brass signal), secondary, ghost, danger.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  iconLeft,
  iconRight,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    'mx-btn',
    `mx-btn--${variant}`,
    size !== 'md' ? `mx-btn--${size}` : '',
    block ? 'mx-btn--block' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button className={cls} {...rest}>
      {iconLeft ? <span className="mx-btn__ic">{iconLeft}</span> : null}
      {children}
      {iconRight ? <span className="mx-btn__ic">{iconRight}</span> : null}
    </button>
  );
}
