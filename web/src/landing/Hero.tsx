import { Check, PaperPlaneTilt } from '@phosphor-icons/react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { LINKS } from './links';
import { BASE, MarkTile, SOLANA } from './marks';
import marks from './marks.module.css';
import { PillButton } from './PillButton';
import styles from './Landing.module.css';

const CHAINS = [SOLANA, BASE] as const;
const SWAP_MS = 3000;
const CONFIRM_AFTER_MS = 1400;
const SLIDE = { duration: 0.42, ease: [0.32, 0.72, 0, 1] } as const;

export function Hero() {
  const heading = useRef<HTMLHeadingElement>(null);
  const inView = useInView(heading);
  const reduced = useReducedMotion();
  const running = inView && !reduced;
  const step = useStep(CHAINS.length, running);
  const confirmed = useConfirmed(step, running);
  const chain = CHAINS[step]!;

  return (
    <section className={styles.hero}>
      <h1 ref={heading} className={styles.heroTitle}>
        <span className={styles.heroLine}>
          Send{' '}
          <Slot id={chain.name}>
            <MarkTile mark={chain} />
          </Slot>{' '}
          transactions
        </span>{' '}
        <span className={styles.heroLine}>
          that{' '}
          <Slot id={confirmed ? 'confirmed' : 'sent'}>
            <StatusTile confirmed={confirmed} />
          </Slot>{' '}
          land on chain.
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

function Slot({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className={styles.slot} aria-hidden="true">
      <AnimatePresence initial={false}>
        <motion.span
          key={id}
          className={styles.slotMark}
          initial={{ y: '110%' }}
          animate={{ y: 0 }}
          exit={{ y: '-110%' }}
          transition={SLIDE}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function StatusTile({ confirmed }: { confirmed: boolean }) {
  const tone = confirmed ? 'confirmed' : 'broadcasting';
  const Icon = confirmed ? Check : PaperPlaneTilt;
  return (
    <span
      className={marks.tile}
      style={{ background: `var(--pill-${tone}-bg)`, color: `var(--pill-${tone}-fg)` }}
    >
      <Icon className={marks.tileGlyph} weight="bold" />
    </span>
  );
}

function useConfirmed(step: number, running: boolean): boolean {
  const [confirmed, setConfirmed] = useState(true);
  useEffect(() => {
    if (!running) {
      setConfirmed(true);
      return;
    }
    setConfirmed(false);
    const timer = setTimeout(() => setConfirmed(true), CONFIRM_AFTER_MS);
    return () => clearTimeout(timer);
  }, [step, running]);
  return confirmed;
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
