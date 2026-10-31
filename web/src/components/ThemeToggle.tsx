import { Desktop, Moon, Sun } from '@phosphor-icons/react';
import { useState } from 'react';

import { applyTheme, readTheme, type Theme } from '../theme';
import styles from './ThemeToggle.module.css';

const OPTIONS = [
  { theme: 'system', label: 'System', Icon: Desktop },
  { theme: 'light', label: 'Light', Icon: Sun },
  { theme: 'dark', label: 'Dark', Icon: Moon },
] as const satisfies readonly { theme: Theme; label: string; Icon: unknown }[];

export function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);

  return (
    <div className={styles.group} role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ theme: option, label, Icon }) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={theme === option}
          aria-label={label}
          title={label}
          className={styles.option}
          onClick={() => {
            applyTheme(option);
            setTheme(option);
          }}
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
