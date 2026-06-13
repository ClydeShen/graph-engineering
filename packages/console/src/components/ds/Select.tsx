import * as React from 'react';

export interface SelectOption { value: string; label: string; }

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Tracked-caps label. */
  label?: React.ReactNode;
  /** Options as strings or {value,label}. Ignored if children given. */
  options?: Array<string | SelectOption>;
}

/** Select — native dropdown dressed as a brushed-metal control. */
export function Select({ label, options = [], children, id, className = '', ...rest }: SelectProps) {
  const fieldId = id || (label ? `mx-sel-${String(label).replace(/\s+/g, '-').toLowerCase()}` : undefined);
  return (
    <div className="mx-select-wrap">
      {label ? <label className="mx-select__label" htmlFor={fieldId}>{label}</label> : null}
      <div className="mx-select-shell">
        <select id={fieldId} className={`mx-select ${className}`} {...rest}>
          {children || options.map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
        <span className="mx-select__chevron">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </div>
    </div>
  );
}
