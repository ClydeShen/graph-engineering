import * as React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Tracked-caps field label. */
  label?: React.ReactNode;
  /** Leading icon node. */
  icon?: React.ReactNode;
  /** Helper text below the field. */
  hint?: React.ReactNode;
  /** Error message — sets invalid state and red hint. */
  error?: React.ReactNode;
}

/** Input — sunken etched text field. Monospace by default for codes & ids. */
export function Input({ label, icon, hint, error, id, className = '', ...rest }: InputProps) {
  const fieldId = id || (label ? `mx-${String(label).replace(/\s+/g, '-').toLowerCase()}` : undefined);
  return (
    <label className="mx-field" htmlFor={fieldId}>
      {label ? <span className="mx-field__label">{label}</span> : null}
      <span className="mx-input-wrap">
        {icon ? <span className="mx-input__icon">{icon}</span> : null}
        <input
          id={fieldId}
          className={`mx-input ${icon ? 'mx-input--has-icon' : ''} ${className}`}
          aria-invalid={error ? 'true' : undefined}
          {...rest}
        />
      </span>
      {error ? <span className="mx-field__hint mx-field__hint--error">{error}</span>
        : hint ? <span className="mx-field__hint">{hint}</span> : null}
    </label>
  );
}
