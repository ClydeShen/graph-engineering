import * as React from 'react';

export interface SwitchProps {
  /** On/off state (controlled). @default false */
  checked?: boolean;
  /** Fires with the next boolean state. */
  onChange?: (checked: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  /** @default false */
  disabled?: boolean;
  /** Trailing text label. */
  label?: React.ReactNode;
  id?: string;
  className?: string;
}

/** Switch — a mechanical toggle. Controlled via `checked` + `onChange`. */
export function Switch({ checked = false, onChange, disabled = false, label, id, className = '' }: SwitchProps) {
  return (
    <label className={`mx-switch ${className}`} data-on={checked} data-disabled={disabled} htmlFor={id}>
      <input
        type="checkbox"
        className="mx-switch__vis"
        role="switch"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked, e)}
      />
      <span className="mx-switch__track"><span className="mx-switch__knob" /></span>
      {label ? <span className="mx-switch__label">{label}</span> : null}
    </label>
  );
}
