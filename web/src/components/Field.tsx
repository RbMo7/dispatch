import {
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

import styles from './TextField.module.css';

interface FieldProps {
  label: string;
  help?: string | undefined;
  /** Below the field, in place of the help, when its value is wrong. */
  error?: string | null | undefined;
}

/** A label above, help or an error below: the frame TextField uses, for any control. */
function Frame({
  label,
  help,
  error,
  children,
}: FieldProps & { children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const note = error ?? help;
  return (
    <div>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children(id, note ? `${id}-note` : undefined)}
      {note && (
        <div id={`${id}-note`} className={error ? styles.error : styles.help}>
          {note}
        </div>
      )}
    </div>
  );
}

export function TextArea({
  label,
  help,
  error,
  ...textarea
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Frame label={label} help={help} error={error}>
      {(id, describedBy) => (
        <textarea
          id={id}
          className={`${styles.input} ${styles.area}`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          {...textarea}
        />
      )}
    </Frame>
  );
}

export function Select({
  label,
  help,
  error,
  options,
  ...select
}: FieldProps &
  SelectHTMLAttributes<HTMLSelectElement> & {
    options: readonly { value: string; label: string }[];
  }) {
  return (
    <Frame label={label} help={help} error={error}>
      {(id, describedBy) => (
        <select
          id={id}
          className={`${styles.input} ${styles.select}`}
          aria-describedby={describedBy}
          {...select}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Frame>
  );
}
