import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Reveal } from '../motion/Reveal';
import styles from './FirstDispatch.module.css';

// The request and response shapes are docs/api.md's POST /v1/dispatch. 0.01 SOL is 10000000 lamports.
const REQUEST = `curl -X POST http://localhost:8420/v1/dispatch \\
  -H "Authorization: Bearer $AUTH_TOKEN" \\
  -H "Idempotency-Key: first-dispatch-1" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chain": "solana",
    "items": [
      { "type": "payment", "recipient": "<address>", "asset": "SOL", "amount": "10000000" }
    ]
  }'`;

const RESPONSE = `{ "dispatchId": "9c5ab36f-0d11-4867-9715-6cf3313aaf92", "status": "queued" }`;

export function FirstDispatch() {
  return (
    <section className={styles.section} aria-labelledby="first-dispatch">
      <Reveal>
        <h2 id="first-dispatch" className={styles.heading}>
          Start with one request.
        </h2>
        <p className={styles.lead}>
          Run the engine with Docker Compose, then send it a payment. It answers at once and does
          the work in the background.
        </p>
      </Reveal>
      <Reveal index={1}>
        <div className={styles.block}>
          <div className={styles.bar}>
            <span>Request</span>
            <CopyButton text={REQUEST} />
          </div>
          <pre className={styles.code}>
            <code>{REQUEST}</code>
          </pre>
          <div className={`${styles.bar} ${styles.barSplit}`}>
            <span>Response</span>
            <span className={styles.status}>202 Accepted</span>
          </div>
          <pre className={styles.code}>
            <code>{RESPONSE}</code>
          </pre>
        </div>
        <p className={styles.after}>
          Then poll <code>GET /v1/dispatch/:id</code> until the payment reads <code>confirmed</code>
          .
        </p>
      </Reveal>
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={styles.copy}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
