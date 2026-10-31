import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import styles from './MonoValue.module.css';

const ELLIPSIS = '…';

export function truncateMiddle(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}${ELLIPSIS}${value.slice(-tail)}`;
}

interface MonoValueProps {
  value: string;
  head?: number;
  tail?: number;
}

export function MonoValue({ value, head, tail }: MonoValueProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard (insecure origin, denied permission): the full value is
      // still in the tooltip and selectable there.
    }
  }

  return (
    <button
      type="button"
      className={styles.value}
      title={value}
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
      onClick={() => void copy()}
    >
      <span>{truncateMiddle(value, head, tail)}</span>
      {copied ? (
        <Check size={12} weight="bold" aria-hidden="true" className={styles.icon} />
      ) : (
        <Copy size={12} aria-hidden="true" className={styles.icon} />
      )}
    </button>
  );
}
