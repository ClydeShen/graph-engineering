import * as React from 'react';

export interface ReadoutProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tracked-caps metric label. */
  label?: React.ReactNode;
  /** The primary value (number or formatted string). */
  value: React.ReactNode;
  /** Trailing unit, e.g. "ms", "/4". */
  unit?: React.ReactNode;
  /** Delta magnitude, e.g. "+12%". */
  delta?: React.ReactNode;
  /** Direction of the delta arrow. @default "flat" */
  trend?: 'up' | 'down' | 'flat';
  /** Value color encoding. @default "default" */
  tone?: 'default' | 'ok' | 'danger' | 'signal' | 'info';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Small caption under the value. */
  footnote?: React.ReactNode;
}

const ARROW: Record<'up' | 'down' | 'flat', string> = { up: '▲', down: '▼', flat: '—' };

/** Readout — a single telemetry value with label, unit and delta. */
export function Readout({
  label,
  value,
  unit,
  delta,
  trend = 'flat',
  tone = 'default',
  size = 'md',
  footnote,
  className = '',
  ...rest
}: ReadoutProps) {
  const cls = ['mx-readout', tone !== 'default' ? `mx-readout--${tone}` : '', size !== 'md' ? `mx-readout--${size}` : '', className]
    .filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      {label ? <span className="mx-readout__label">{label}</span> : null}
      <div className="mx-readout__value-row">
        <span className="mx-readout__value">{value}</span>
        {unit ? <span className="mx-readout__unit">{unit}</span> : null}
        {delta != null ? (
          <span className={`mx-readout__delta mx-readout__delta--${trend}`}>
            <span aria-hidden="true">{ARROW[trend]}</span>{delta}
          </span>
        ) : null}
      </div>
      {footnote ? <span className="mx-readout__foot">{footnote}</span> : null}
    </div>
  );
}
