import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { LINKS } from './links';
import { AWS_KMS, BASE, type Mark, MarkTile, PRIVY, SAFE, SOLANA, SQUADS } from './marks';
import { PillButton } from './PillButton';
import styles from './Landing.module.css';

// Each step shows a pair that belongs together: a chain and its multisig, then the two signing backends.
const FIRST_SLOT = [SOLANA, BASE, PRIVY] as const;
const SECOND_SLOT = [SQUADS, SAFE, AWS_KMS] as const;
const SWAP_MS = 3000;
const SLIDE = { duration: 0.42, ease: [0.32, 0.72, 0, 1] } as const;

export function Hero() {
  const heading = useRef<HTMLHeadingElement>(null);
  const inView = useInView(heading);
  const reduced = useReducedMotion();
  const step = useStep(FIRST_SLOT.length, inView && !reduced);

  return (
    <section className={styles.hero}>
      <h1 ref={heading} className={styles.heroTitle}>
        <span className={styles.heroLine}>
          Send <Slot mark={FIRST_SLOT[step]!} /> transactions
        </span>{' '}
        <span className={styles.heroLine}>
          that <Slot mark={SECOND_SLOT[step]!} delay={0.12} /> land on chain.
        </span>
      </h1>
      <p className={styles.heroSub}>
        A self-hosted engine that signs, sends, retries and confirms your payments and contract
        calls on Solana and Base.
      </p>
      <div className={styles.actions}>
        <PillButton href={LINKS.getStarted}>Get started</PillButton>
        <PillButton variant="soft" arrow href={LINKS.github}>
          View on GitHub
        </PillButton>
      </div>
    </section>
  );
}

function Slot({ mark, delay = 0 }: { mark: Mark; delay?: number }) {
  return (
    <span className={styles.slot} aria-hidden="true">
      <AnimatePresence initial={false}>
        <motion.span
          key={mark.name}
          className={styles.slotMark}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '-110%' }}
          transition={{ ...SLIDE, delay }}
        >
          <MarkTile mark={mark} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function useStep(length: number, running: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (!document.hidden) setStep((current) => (current + 1) % length);
    }, SWAP_MS);
    return () => clearInterval(timer);
  }, [length, running]);
  return step;
}
