import * as React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** ghost (default), solid (raised panel), signal (brass). @default "ghost" */
  variant?: 'ghost' | 'solid' | 'signal';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Required for accessibility — describes the action. */
  'aria-label': string;
}

/** IconButton — a square, label-less control. Pass an Icon as children. */
export function IconButton({
  variant = 'ghost',
  size = 'md',
  className = '',
  children,
  'aria-label': ariaLabel,
  ...rest
}: IconButtonProps) {
  const cls = [
    'mx-iconbtn',
    variant === 'solid' ? 'mx-iconbtn--solid' : '',
    variant === 'signal' ? 'mx-iconbtn--signal' : '',
    size !== 'md' ? `mx-iconbtn--${size}` : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} aria-label={ariaLabel} {...rest}>
      {children}
    </button>
  );
}
