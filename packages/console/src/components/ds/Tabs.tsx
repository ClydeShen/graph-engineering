import * as React from 'react';

export interface TabItem { value: string; label: React.ReactNode; icon?: React.ReactNode; }

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Tabs as strings or {value,label,icon}. */
  items: Array<string | TabItem>;
  /** Selected value (controlled). */
  value: string;
  /** Fires with the next value. */
  onChange?: (value: string) => void;
  /** Stretch tabs to fill width. @default false */
  full?: boolean;
}

/** Tabs — a segmented instrument selector. Controlled via `value`. */
export function Tabs({ items = [], value, onChange, full = false, className = '', ...rest }: TabsProps) {
  const cls = ['mx-tabs', full ? 'mx-tabs--full' : '', className].filter(Boolean).join(' ');
  return (
    <div className={cls} role="tablist" {...rest}>
      {items.map((it) => {
        const item: TabItem = typeof it === 'string' ? { value: it, label: it } : it;
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            aria-selected={selected}
            className="mx-tab"
            onClick={() => onChange?.(item.value)}
          >
            {item.icon ? item.icon : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
