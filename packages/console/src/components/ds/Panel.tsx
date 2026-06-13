import * as React from 'react';

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** Surface treatment. @default "default" */
  variant?: 'default' | 'raised' | 'sunken' | 'flush';
  /** Tracked-caps legend above the title. */
  eyebrow?: React.ReactNode;
  /** Display-font panel title. */
  title?: React.ReactNode;
  /** Right-aligned header controls (IconButtons, Badges). */
  actions?: React.ReactNode;
  /** Overlay film grain. @default false */
  grain?: boolean;
  /** Etched corner brackets. @default false */
  corners?: boolean;
  /** Render children directly without the padded body wrapper. @default false */
  noBody?: boolean;
  /** Extra class on the body wrapper. */
  bodyClassName?: string;
}

/**
 * Panel — the etched instrument enclosure. The structural backbone of
 * every Memex surface: brushed sheen, hairline border, engraved edge.
 */
export function Panel({
  variant = 'default',
  eyebrow,
  title,
  actions,
  grain = false,
  corners = false,
  bodyClassName = '',
  noBody = false,
  className = '',
  children,
  ...rest
}: PanelProps) {
  const cls = [
    'mx-panel',
    variant !== 'default' ? `mx-panel--${variant}` : '',
    corners ? 'mx-panel--corners' : '',
    className,
  ].filter(Boolean).join(' ');

  const hasHeader = eyebrow || title || actions;

  return (
    <section className={cls} {...rest}>
      {grain ? <span className="mx-panel__grain" /> : null}
      {hasHeader ? (
        <header className="mx-panel__hd">
          <div className="mx-panel__hd-text">
            {eyebrow ? <span className="mx-panel__eyebrow">{eyebrow}</span> : null}
            {title ? <span className="mx-panel__title">{title}</span> : null}
          </div>
          {actions ? <div className="mx-panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      {noBody ? children : <div className={`mx-panel__body ${bodyClassName}`}>{children}</div>}
    </section>
  );
}
