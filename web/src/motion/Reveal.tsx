import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { REVEAL_STAGGER_S, reveal } from './transitions';

// Fades in and rises as it enters the viewport, once. `index` staggers
// siblings. Under reduced motion the rise is dropped and only the fade stays.
export function Reveal({ children, index = 0 }: { children: ReactNode; index?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ ...reveal, delay: index * REVEAL_STAGGER_S }}
    >
      {children}
    </motion.div>
  );
}
