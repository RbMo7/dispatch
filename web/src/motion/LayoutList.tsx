import { AnimatePresence, motion } from 'motion/react';
import { forwardRef, type ReactNode } from 'react';

import { layoutSpring } from './transitions';
import styles from './LayoutList.module.css';

// Children must be <LayoutItem key=...>. A new key slides in from the top, a
// moved key glides to its new place, and a removed key fades while the rest
// close the gap.
export function LayoutList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className={styles.list} aria-label={label}>
      <AnimatePresence initial={false} mode="popLayout">
        {children}
      </AnimatePresence>
    </ul>
  );
}

export const LayoutItem = forwardRef<HTMLLIElement, { children: ReactNode }>(function LayoutItem(
  { children },
  ref,
) {
  return (
    <motion.li
      ref={ref}
      layout
      className={styles.item}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={layoutSpring}
    >
      {children}
    </motion.li>
  );
});
