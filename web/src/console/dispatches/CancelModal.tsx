import { useEffect, useState } from 'react';

import { Amount } from '../../components/Amount';
import { Button } from '../../components/Button';
import type { DispatchDetail } from '../../domain/dispatch';
import { Modal } from '../../motion/Overlay';
import { ApiError, describeFailure } from '../api/client';
import styles from '../console.module.css';
import { useApi } from '../session';
import type { PaneHead } from './DispatchPane';

type Step =
  | { kind: 'confirm' }
  | { kind: 'sending' }
  | { kind: 'too-late'; message: string }
  | { kind: 'error'; message: string };

const count = new Intl.NumberFormat('en-US');

interface CancelModalProps {
  open: boolean;
  head: PaneHead;
  itemCount: number;
  onClose: () => void;
  onCancelled: (detail: DispatchDetail) => void;
}

/** One decision: withdraw a Dispatch the engine has not claimed yet (ADR-0056). */
export function CancelModal({ open, head, itemCount, onClose, onCancelled }: CancelModalProps) {
  const api = useApi();
  const [step, setStep] = useState<Step>({ kind: 'confirm' });

  useEffect(() => {
    if (open) setStep({ kind: 'confirm' });
  }, [open, head.id]);

  async function cancel() {
    setStep({ kind: 'sending' });
    try {
      onCancelled(await api.cancelDispatch(head.id));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const { failure } = error;
      setStep(
        failure.kind === 'refused' && failure.code === 'ALREADY_CLAIMED'
          ? { kind: 'too-late', message: failure.message }
          : { kind: 'error', message: describeFailure(failure) },
      );
    }
  }

  const what =
    head.mode === 'relay'
      ? 'Its signed transaction'
      : itemCount === 1
        ? 'Its one item'
        : `All ${count.format(itemCount)} items`;
  const settled = step.kind === 'too-late';

  return (
    <Modal
      open={open}
      title="Cancel Dispatch"
      onClose={onClose}
      footer={
        settled ? (
          <Button variant="secondary" data-autofocus onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" data-autofocus onClick={onClose}>
              Keep it
            </Button>
            <Button
              variant="danger-filled"
              disabled={step.kind === 'sending'}
              onClick={() => void cancel()}
            >
              {step.kind === 'sending' ? 'Cancelling' : 'Cancel Dispatch'}
            </Button>
          </>
        )
      }
    >
      <div className={styles.cancelCard}>
        <div>
          <div className={styles.cancelName}>{head.name}</div>
          <div className={styles.mono}>{head.id}</div>
        </div>
        {head.totals[0] && <Amount {...head.totals[0]} />}
      </div>
      {settled ? (
        <div className={styles.cancelRefused} role="alert">
          <p className={styles.cancelText}>
            Too late to cancel. The engine claimed this Dispatch before the cancel reached it, so it
            may already be signed or sent, and a signed transaction cannot be taken back. Watch it
            in the Flow tab.
          </p>
          <p className={styles.cancelDetail}>{step.message}</p>
        </div>
      ) : (
        <p className={styles.cancelText}>
          The engine hasn&apos;t claimed it yet, so nothing has been signed. {what} will be marked
          cancelled. Send it again with a new Idempotency-Key if you need it.
        </p>
      )}
      {step.kind === 'error' && (
        <p className={styles.cancelError} role="alert">
          {step.message}
        </p>
      )}
    </Modal>
  );
}
