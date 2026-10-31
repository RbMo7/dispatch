import { Sparkle } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

const DOTS: [x: number, y: number, r: number][] = [
  [28, 40, 1.5],
  [52, 18, 1.2],
  [64, 66, 1.6],
  [84, 34, 1.1],
  [92, 80, 1.3],
  [136, 14, 1.4],
  [140, 74, 1.2],
  [158, 44, 1.5],
  [176, 22, 1.1],
  [188, 62, 1.4],
  [40, 74, 1],
  [200, 38, 1],
];

export function EmptyState({ caption, action }: { caption: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <div className={styles.field} aria-hidden="true">
        <svg width="220" height="96" viewBox="0 0 220 96">
          {DOTS.map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="var(--faint)" />
          ))}
        </svg>
        <span className={styles.mark}>
          <Sparkle size={18} weight="regular" />
        </span>
      </div>
      <p className={styles.caption}>{caption}</p>
      {action}
    </div>
  );
}
