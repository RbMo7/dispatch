import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

import { REVEAL_STAGGER_S, reveal } from './transitions';

export function Reveal({ children, index = 0 }: { children: ReactNode; index?: number }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ ...reveal, delay: index * REVEAL_STAGGER_S }}
    >
      {children}
    </motion.div>
  );
}
