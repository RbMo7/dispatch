import { useState } from 'react';

import { applyTheme, readTheme, type Theme } from '../theme';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: Theme; label: string }[];

export function ThemeSetting() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <SegmentedControl
      label="Appearance"
      options={OPTIONS}
      value={theme}
      onChange={(next) => {
        applyTheme(next);
        setTheme(next);
      }}
    />
  );
}
