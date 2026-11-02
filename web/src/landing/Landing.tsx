import { useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { Reveal } from '../motion/Reveal';
import { ConsoleScreen } from './console';
import { Features } from './Features';
import { FirstDispatch } from './FirstDispatch';
import { Hero } from './Hero';
import { LINKS } from './links';
import { MARKS, MarkGlyph } from './marks';
import { PillButton } from './PillButton';
import { Scaled } from './Scaled';
import styles from './Landing.module.css';

export function Landing() {
  return (
    <div className={styles.page}>
      <Nav />
      <main>
        <Hero />
        <ProductFrame />
        <WorksWith />
        <Statement />
        <Features />
        <FirstDispatch />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className={styles.nav}>
      <a className={styles.wordmark} href="/">
        Dispatch
      </a>
      <nav className={styles.navLinks} aria-label="Site">
        <a href={LINKS.docs}>Docs</a>
        <a href={LINKS.github}>GitHub</a>
        <a href={LINKS.changelog}>Changelog</a>
      </nav>
      <PillButton href={LINKS.getStarted}>Get started</PillButton>
    </header>
  );
}

const CONFIRM_AFTER_MS = 2500;

function ProductFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduced = useReducedMotion();
  const [landed, setLanded] = useState(false);

  // One recorded row settles while you look: the fee-bumped Bulk Call goes from broadcasting to confirmed.
  useEffect(() => {
    if (!inView || reduced) return;
    const timer = setTimeout(() => setLanded(true), CONFIRM_AFTER_MS);
    return () => clearTimeout(timer);
  }, [inView, reduced]);

  return (
    <div className={styles.productWrap}>
      <Reveal>
        <figure ref={ref} className={styles.product}>
          <div className={styles.productInner}>
            <Scaled width={1360} height={800} minScale={0.62} anchor="right">
              <ConsoleScreen landed={landed} />
            </Scaled>
          </div>
          <figcaption className="visually-hidden">
            The Dispatch console: Dispatches grouped by day with their status and total, and a
            1,000-payment Dispatch open on its flow, 612 of 1,000 confirmed.
          </figcaption>
        </figure>
      </Reveal>
    </div>
  );
}

function WorksWith() {
  return (
    <section className={styles.works} aria-labelledby="works-with">
      <h2 id="works-with" className={styles.worksLabel}>
        Works with
      </h2>
      <ul className={styles.worksList}>
        {MARKS.map((mark) => (
          <li key={mark.name} className={styles.worksItem}>
            <MarkGlyph mark={mark} className={styles.worksGlyph} />
            {mark.name}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Statement() {
  return (
    <section className={styles.statement}>
      <Reveal>
        <p className={styles.statementText}>
          Sending one transaction is easy.{' '}
          <span className={styles.statementQuiet}>
            Sending ten thousand that all land, through timeouts, fee spikes and restarts, is the
            job.
          </span>
        </p>
      </Reveal>
    </section>
  );
}

function Closing() {
  return (
    <section className={styles.closing}>
      <Reveal>
        <h2 className={styles.closingTitle}>Run it next to your own keys.</h2>
        <p className={styles.heroSub}>
          Open source under MIT. Docker Compose starts the API, the worker, Postgres and a Signer.
        </p>
        <div className={styles.actions}>
          <PillButton href={LINKS.getStarted}>Get started</PillButton>
          <PillButton variant="soft" arrow href={LINKS.github}>
            View on GitHub
          </PillButton>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className={styles.footer}>
      <span className={styles.wordmark}>Dispatch</span>
      <nav className={styles.footerLinks} aria-label="Footer">
        <a href={LINKS.docs}>Docs</a>
        <a href={LINKS.github}>GitHub</a>
        <a href={LINKS.license}>License (MIT)</a>
        <a href={LINKS.changelog}>Changelog</a>
      </nav>
    </footer>
  );
}
