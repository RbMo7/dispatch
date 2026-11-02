import { type FormEvent, useEffect, useState } from 'react';

import { Amount } from '../../components/Amount';
import { Button } from '../../components/Button';
import { TextArea } from '../../components/Field';
import type { DispatchDetail } from '../../domain/dispatch';
import { Modal } from '../../motion/Overlay';
import { ApiError, describeFailure } from '../api/client';
import styles from '../console.module.css';
import type { PaneHead } from '../dispatches/DispatchPane';
import ops from '../operator.module.css';
import { useApi } from '../session';

const count = new Intl.NumberFormat('en-US');

interface ReleaseModalProps {
  open: boolean;
  head: PaneHead;
  itemCount: number;
  onClose: () => void;
  onReleased: (detail: DispatchDetail) => void;
}

/** One decision: let a held Dispatch go ahead, with the reason the activity record keeps (ADR-0058). */
export function ReleaseModal({ open, head, itemCount, onClose, onReleased }: ReleaseModalProps) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setSending(false);
    setError(null);
  }, [open, head.id]);

  const ready = reason.trim().length > 0;

  async function release(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setSending(true);
    setError(null);
    try {
      onReleased(await api.releaseDispatch(head.id, reason.trim()));
    } catch (failure) {
      if (!(failure instanceof ApiError)) throw failure;
      setError(describeFailure(failure.failure));
      setSending(false);
    }
  }

  const what = itemCount === 1 ? 'its one item' : `all ${count.format(itemCount)} items`;

  return (
    <Modal
      open={open}
      title="Release Dispatch"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it held
          </Button>
          <Button variant="primary" type="submit" form="release-form" disabled={!ready || sending}>
            {sending ? 'Releasing' : 'Release'}
          </Button>
        </>
      }
    >
      <div className={styles.cancelCard}>
        <div>
          <div className={styles.cancelName}>{head.name}</div>
          <div className={styles.mono}>{head.id}</div>
        </div>
        {head.totals[0] && <Amount {...head.totals[0]} />}
      </div>
      <p className={styles.cancelText}>
        Nothing has been signed yet. Once released, the engine claims it as if it had never been
        held, then signs and sends {what}.
      </p>
      <form
        id="release-form"
        className={ops.dialogField}
        onSubmit={(event) => void release(event)}
        noValidate
      >
        <TextArea
          label="Reason"
          data-autofocus
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          help="Required. The activity record keeps it with this release."
          error={error}
        />
      </form>
    </Modal>
  );
}
