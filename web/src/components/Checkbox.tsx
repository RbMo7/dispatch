import { Check, Minus } from '@phosphor-icons/react';
import { type InputHTMLAttributes, useEffect, useRef } from 'react';

import styles from './Checkbox.module.css';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visible text beside the box; without it, pass `aria-label`. */
  label?: string;
  indeterminate?: boolean;
}

export function Checkbox({ label, indeterminate = false, className, ...rest }: CheckboxProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={className ? `${styles.wrap} ${className}` : styles.wrap}>
      <input ref={input} type="checkbox" className={styles.input} {...rest} />
      <span className={styles.box} aria-hidden="true">
        <Check size={10} weight="bold" className={styles.check} />
        <Minus size={10} weight="bold" className={styles.minus} />
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
}
