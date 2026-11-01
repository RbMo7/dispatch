import { Eye, EyeSlash } from '@phosphor-icons/react';

import { useBalances } from '../balances';
import { Button } from './Button';

export function EyeToggle() {
  const { hidden, setHidden } = useBalances();
  const label = hidden ? 'Show balances' : 'Hide balances';
  return (
    <Button
      variant="quiet"
      icon
      aria-pressed={hidden}
      aria-label={label}
      title={label}
      onClick={() => setHidden(!hidden)}
    >
      {hidden ? <EyeSlash size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
    </Button>
  );
}
