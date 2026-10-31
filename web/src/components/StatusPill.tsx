import { Check, CircleHalf, Clock, Pause, Prohibit, User, X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

import { pillMorph } from '../motion/transitions';
import { type Glyph, type Status, STATUSES } from './status';
import styles from './StatusPill.module.css';

const ICON = { size: 12, weight: 'bold', 'aria-hidden': true } as const;

const GLYPHS: Record<Glyph, ReactNode> = {
  'hollow-dot': <span className={styles.hollowDot} />,
  'pulse-dot': <span className={styles.pulseDot} />,
  person: <User {...ICON} />,
  pause: <Pause {...ICON} weight="fill" />,
  check: <Check {...ICON} />,
  half: <CircleHalf {...ICON} weight="fill" />,
  cross: <X {...ICON} />,
  clock: <Clock {...ICON} />,
  slash: <Prohibit {...ICON} />,
};

export function StatusPill({ status }: { status: Status }) {
  const { label, glyph, tone } = STATUSES[status];
  const colours = {
    color: `var(--pill-${tone}-fg)`,
    backgroundColor: `var(--pill-${tone}-bg)`,
  } satisfies CSSProperties;

  // layout morphs the width; the content fades across the swap. Under reduced
  // motion MotionConfig drops the layout transform and keeps only the fade.
  return (
    <motion.span
      layout
      transition={pillMorph}
      className={styles.pill}
      data-status={status}
      style={{ ...colours, borderRadius: 'var(--radius-pill)' }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={status}
          layout="position"
          className={styles.content}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={pillMorph}
        >
          <span className={styles.glyph} aria-hidden="true">
            {GLYPHS[glyph]}
          </span>
          <span className={styles.label}>{label}</span>
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}
