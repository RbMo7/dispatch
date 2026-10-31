import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useRef } from 'react';

import styles from './SearchField.module.css';

interface SearchFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number;
}

export function SearchField({ label, value, onChange, placeholder, width = 220 }: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.field} style={{ width }}>
      <MagnifyingGlass size={14} className={styles.icon} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        className={styles.input}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <button
          type="button"
          className={styles.clear}
          aria-label="Clear search"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <X size={12} weight="bold" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
