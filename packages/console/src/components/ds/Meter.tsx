import * as React from 'react';

export interface MeterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Current value. */
  value: number;
  /** Maximum. With `segmented`, also the number of slots. @default 100 */
  max?: number;
  /** Fill color encoding. @default "signal" */
  tone?: 'signal' | 'ok' | 'danger' | 'info';
  /** Tracked-caps label. */
  label?: React.ReactNode;
  /** Show the value/max readout. @default true */
  showValue?: boolean;
  /** Render discrete slots instead of a continuous bar. @default false */
  segmented?: boolean;
}

/** Meter — a slot / backlog gauge. Continuous bar or segmented slots. */
export function Meter({
  value,
  max = 100,
  tone = 'signal',
  label,
  showValue = true,
  segmented = false,
  className = '',
  ...rest
}: MeterProps) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const cls = ['mx-meter', `mx-meter--${tone}`, className].filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      {(label || showValue) ? (
        <div className="mx-meter__top">
          {label ? <span className="mx-meter__label">{label}</span> : <span />}
          {showValue ? <span className="mx-meter__read">{value}<span style={{ color: 'var(--text-muted)' }}>/{max}</span></span> : null}
        </div>
      ) : null}
      {segmented ? (
        <div className="mx-meter__segs">
          {Array.from({ length: max }).map((_, i) => (
            <span key={i} className={`mx-meter__seg ${i < value ? 'mx-meter__seg--on' : ''}`} />
          ))}
        </div>
      ) : (
        <div className="mx-meter__track">
          <span className="mx-meter__fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </div>
  );
}
