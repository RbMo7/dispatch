import { type InputHTMLAttributes, useId } from 'react';

import styles from './TextField.module.css';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  help?: string;
}

// Label above, help below, never a placeholder standing in for the label.
export function TextField({ label, help, ...input }: TextFieldProps) {
  const id = useId();
  return (
    <div>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input id={id} className={styles.input} aria-describedby={help ? `${id}-help` : undefined} {...input} />
      {help && (
        <div id={`${id}-help`} className={styles.help}>
          {help}
        </div>
      )}
    </div>
  );
}
