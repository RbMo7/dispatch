import { useEffect, useState } from 'react';

import styles from './MonoValue.module.css';

const ELLIPSIS = '…';

export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}${ELLIPSIS}${value.slice(-tail)}`;
}

interface MonoValueProps {
  value: string;
  head?: number;
  tail?: number;
  /** Show the whole value, wrapped, instead of truncating it. */
  full?: boolean;
}

// A hash, address or id: middle-truncated, the full value on hover, copied on click.
export function MonoValue({ value, head, tail, full = false }: MonoValueProps) {
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
      // still in the tooltip.
    }
  }

  return (
    <button
      type="button"
      className={full ? `${styles.value} ${styles.full}` : styles.value}
      title={copied ? 'Copied' : value}
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
      data-copied={copied || undefined}
      onClick={() => void copy()}
    >
      {full ? value : truncateMiddle(value, head, tail)}
    </button>
  );
}
