import { useState } from 'react';

import { Amount } from '../../components/Amount';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ChainDot } from '../../components/ChainDot';
import { Checkbox } from '../../components/Checkbox';
import { EmptyState } from '../../components/EmptyState';
import { MonoValue } from '../../components/MonoValue';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StackedBar } from '../../components/StackedBar';
import { StatusPill } from '../../components/StatusPill';
import { TextField } from '../../components/TextField';
import { ThemeSetting } from '../../components/ThemeSetting';
import { useToast } from '../../components/Toast';
import { share } from '../../domain/assets';
import { ALL_STATUSES, type Status } from '../../domain/status';
import { ModalFrame } from '../../motion/Overlay';
import { money } from '../fixtures';
import styles from './Gallery.module.css';

const STEPS: Status[] = ['queued', 'broadcasting', 'awaiting_approval', 'confirmed'];
const RANGES = [
  { value: '1h', label: '1H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
] as const;

export function Primitives({ onOpenModal }: { onOpenModal: () => void }) {
  const [step, setStep] = useState(0);
  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('24h');
  const toast = useToast();
  const pills = ALL_STATUSES.map((status, index) =>
    index === 0 ? STEPS[step % STEPS.length]! : status,
  );

  return (
    <div className={styles.primitives}>
      <Card title="Buttons" className={styles.span5}>
        <div className={styles.wrap}>
          <Button variant="primary">Release</Button>
          <Button variant="secondary">Open in Safe</Button>
          <Button variant="quiet">Clear filters</Button>
          <Button variant="danger">Cancel Dispatch</Button>
          <Button variant="danger-filled">Remove key</Button>
          <Button variant="primary" disabled>
            Release
          </Button>
        </div>
        <p className={styles.help}>32 px tall, 8 px corners. One primary per view.</p>
      </Card>

      <Card
        title="Status"
        className={styles.span7}
        aside={
          <Button
            variant="quiet"
            className={styles.smallQuiet}
            onClick={() => setStep((s) => s + 1)}
          >
            Step the first pill
          </Button>
        }
      >
        <div className={styles.wrap}>
          {pills.map((status, index) => (
            <StatusPill key={index} status={status} />
          ))}
        </div>
        <p className={styles.help}>
          Text only, no icons or dots. Colour fades over 160 ms when a status changes.
        </p>
      </Card>

      <Card
        title="In flight"
        link={{ label: 'Dispatches', href: '#dispatches' }}
        className={styles.span4}
      >
        <div className={styles.inFlight}>
          <div className={styles.bigNumber}>14</div>
          <div className={styles.muted}>9 broadcasting, 3 awaiting approval, 2 held</div>
        </div>
        <svg
          viewBox="0 0 320 70"
          width="100%"
          height="70"
          aria-hidden="true"
          className={styles.chart}
        >
          <path
            d="M0 52 L40 50 L80 51 L120 44 L160 46 L200 40 L240 41 L280 30 L300 31"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d="M0 56 L320 18"
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
          <circle
            cx="300"
            cy="31"
            r="4"
            fill="var(--surface)"
            stroke="var(--accent)"
            strokeWidth="2"
          />
        </svg>
        <div className={styles.center}>
          <SegmentedControl label="Range" options={RANGES} value={range} onChange={setRange} />
        </div>
      </Card>

      <Card
        title="Senders"
        link={{ label: 'Senders & Keys', href: '#senders' }}
        className={styles.span4}
      >
        <div className={styles.senderRows}>
          <SenderRow
            chain="solana"
            name="Treasury vault"
            balance={money('1842.30', 'USDC')}
            committed={money('700.00', 'USDC')}
            note="committed to open Proposals"
          />
          <SenderRow
            chain="base"
            name="Payouts sender"
            balance={money('0.8412', 'ETH')}
            committed={money('0.7650', 'ETH')}
            low
            note="committed, 0.0762 free"
          />
        </div>
      </Card>

      <Card title="Needs attention" className={styles.span4}>
        <EmptyState caption="Nothing needs you. 212 Dispatches settled today." />
      </Card>

      <Card title="Signer key" className={styles.span5}>
        <dl className={styles.kv}>
          <dt>Curve</dt>
          <dd className={styles.mono}>secp256k1</dd>
          <dt>Pinned to</dt>
          <dd>
            <MonoValue value="0x4c1e2f0a9b7d3e5c8a6f1b2d4e9c0a7f3b5d9a07" />{' '}
            <span className={styles.muted}>(the configured Safe)</span>
          </dd>
          <dt>Chains</dt>
          <dd>Base 8453</dd>
          <dt>Check</dt>
          <dd className={styles.ok}>Pinned to this Safe</dd>
        </dl>
      </Card>

      <Card title="Form controls" className={styles.span7}>
        <div className={styles.formGrid}>
          <TextField
            label="Operator token"
            type="password"
            defaultValue="op_live_7Qm2Xc9Lr4"
            help="Kept for this tab only."
          />
          <TextField
            label="Reason for release"
            placeholder="Checked against payroll file 2026-10"
            help="Required. It goes in the Activity log."
          />
        </div>
        <div className={styles.formRow}>
          <Checkbox label="Include cancelled" defaultChecked />
          <Checkbox label="Only mine" />
          <Checkbox label="Some selected" indeterminate />
          <span className={styles.formSetting}>
            <span className={styles.settingLabel}>Appearance</span>
            <ThemeSetting />
          </span>
          <Button variant="secondary" onClick={() => toast('Exported 1,000 rows')}>
            Show a toast
          </Button>
        </div>
      </Card>

      <div className={styles.modalStage}>
        <div className={styles.inlineModal} role="group" aria-label="Cancel Dispatch, shown inline">
          <ModalFrame
            title="Cancel Dispatch"
            onClose={() => {}}
            footer={
              <>
                <Button variant="secondary">Keep it</Button>
                <Button variant="danger-filled" onClick={onOpenModal}>
                  Cancel Dispatch
                </Button>
              </>
            }
          >
            <CancelSummary />
          </ModalFrame>
        </div>
      </div>
    </div>
  );
}

function SenderRow({
  chain,
  name,
  balance,
  committed,
  low = false,
  note,
}: {
  chain: 'solana' | 'base';
  name: string;
  balance: ReturnType<typeof money>;
  committed: ReturnType<typeof money>;
  low?: boolean;
  note: string;
}) {
  return (
    <div>
      <div className={styles.senderRowLine}>
        <ChainDot chain={chain}>{name}</ChainDot>
        <Amount {...balance} />
      </div>
      <div className={styles.senderBar}>
        <StackedBar committed={share(committed, balance)} low={low} />
      </div>
      <div className={styles.help}>
        <Amount {...committed} variant="plain" /> {note}
      </div>
    </div>
  );
}

export function CancelSummary() {
  return (
    <>
      <div className={styles.cancelCard}>
        <div>
          <div className={styles.cancelName}>Creator rewards</div>
          <div className={styles.mono}>2b6f0a88</div>
        </div>
        <Amount {...money('3215.50', 'USDC')} />
      </div>
      <p className={styles.cancelText}>
        The engine hasn't claimed it yet, so nothing has been signed. All 128 payments will be
        marked cancelled. Send it again with a new Idempotency-Key if you need it.
      </p>
    </>
  );
}
