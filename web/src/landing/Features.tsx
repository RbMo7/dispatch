import { useEffect, useState, type ReactNode } from 'react';

import { Reveal } from '../motion/Reveal';
import { DispatchRows, Flow, SidebarView } from './console';
import styles from './Features.module.css';
import { Scaled } from './Scaled';

interface Feature {
  id: string;
  nav: string;
  heading: string;
  visual: ReactNode;
  body: string | readonly [string, string, string];
}

const FEATURES: readonly Feature[] = [
  {
    id: 'send',
    nav: 'Send',
    heading: 'A whole payout in one request.',
    visual: (
      <Scaled width={560} height={400}>
        <DispatchRows />
      </Scaled>
    ),
    body: "POST payments and contract calls with an Idempotency-Key. Dispatch checks the Sender can pay, sends them and reports each item's status. The same key twice returns the first Dispatch.",
  },
  {
    id: 'sign',
    nav: 'Sign',
    heading: 'Your keys stay behind your Signer.',
    visual: (
      <Scaled width={232} height={300} offsetY={238} maxScale={1.45}>
        <SidebarView />
      </Scaled>
    ),
    body: [
      'Privy server wallets, AWS KMS or an encrypted keystore, chosen per address',
      'A policy for each address that the Signer enforces on its own',
      'Every signature checked by the engine before anything is sent',
    ],
  },
  {
    id: 'approve',
    nav: 'Approve',
    heading: 'People approve. The engine does the rest.',
    visual: (
      <Scaled width={420} height={330} offsetY={138}>
        <Flow id="approval" />
      </Scaled>
    ),
    body: 'Point a Sender at a Squads multisig or a Safe. Dispatch proposes the transfers, Approvers sign in the app they already use, and the engine executes at the threshold. It never approves.',
  },
  {
    id: 'watch',
    nav: 'Watch',
    heading: 'Every transaction is written down before it is sent.',
    visual: (
      <Scaled width={420} height={330} offsetY={215}>
        <Flow id="fee-bump" />
      </Scaled>
    ),
    body: [
      'A stuck Base transaction is rebroadcast, and fee-bumped at the same nonce if you allow it',
      'An expired Solana transaction is resent with a fresh blockhash, up to three times',
      'A timeout is checked against the chain, never guessed as a failure',
    ],
  },
];

const COMPARE: readonly (readonly [string, string])[] = [
  ['Hosting', 'Self-hosted. You run the API, the worker, the Signer and Postgres.'],
  ['Chains', 'Solana and Base. Ethereum L1 and other chains are not built yet.'],
  ['Mainnet', 'Proven on Solana devnet and Base Sepolia. Not yet run on mainnet.'],
  ['Updates', 'You poll GET /v1/dispatch/:id. Webhooks are not built yet.'],
  ['Keys', 'Privy and AWS KMS for production. KMS is so far tested only against mocks.'],
  ['Multisig', 'Proposes and executes. Approvers decide in Squads or Safe.'],
];

const SECTIONS = [
  ...FEATURES.map((f) => ({ id: f.id, nav: f.nav })),
  { id: 'compare', nav: 'Compare' },
];

export function Features() {
  const active = useActiveSection(SECTIONS.map((s) => s.id));

  return (
    <section className={styles.features} aria-label="What Dispatch does">
      <nav className={styles.nav} aria-label="Features">
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={styles.navLink}
            data-rule={section.id === 'compare' || undefined}
            aria-current={section.id === active ? 'location' : undefined}
          >
            {section.nav}
          </a>
        ))}
      </nav>

      {FEATURES.map((feature) => (
        <article key={feature.id} id={feature.id} className={styles.block}>
          <Reveal>
            <div className={styles.frame}>
              <div className={styles.frameInner}>{feature.visual}</div>
            </div>
          </Reveal>
          <Reveal index={1}>
            <div className={styles.text}>
              <h2 className={styles.heading}>{feature.heading}</h2>
              {typeof feature.body === 'string' ? (
                <p className={styles.body}>{feature.body}</p>
              ) : (
                <ul className={styles.list}>
                  {feature.body.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          </Reveal>
        </article>
      ))}

      <article id="compare" className={`${styles.block} ${styles.compare}`}>
        <Reveal>
          <h2 className={styles.heading}>What it does, and what it doesn't yet.</h2>
          <table className={styles.table}>
            <tbody>
              {COMPARE.map(([topic, answer]) => (
                <tr key={topic}>
                  <th scope="row">{topic}</th>
                  <td>{answer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </article>
    </section>
  );
}

/** The section crossing a line just above the middle of the viewport. */
function useActiveSection(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0]!);
  const key = ids.join(' ');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((entry) => entry.isIntersecting);
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    for (const id of key.split(' ')) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);

  return active;
}
