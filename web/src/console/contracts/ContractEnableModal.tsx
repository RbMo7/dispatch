import { type FormEvent, useEffect, useState } from 'react';

import { Button } from '../../components/Button';
import { TextArea } from '../../components/Field';
import { MonoValue } from '../../components/MonoValue';
import { definitionName } from '../../domain/calls';
import { CHAINS } from '../../domain/chains';
import type { KnownContract } from '../../domain/contracts';
import { Modal } from '../../motion/Overlay';
import css from '../assets/assets.module.css';
import { assetRefusal, type Refusal, RefusalNote } from '../assets/RefusalNote';
import styles from '../console.module.css';
import ops from '../operator.module.css';
import { useApi } from '../session';

interface ContractEnableModalProps {
  /** The contract to flip, or null while closed. */
  contract: KnownContract | null;
  onClose: () => void;
  onChanged: (contract: KnownContract) => void;
}

/** One decision: stop a registered ABI or IDL explaining calls, or let it again. */
export function ContractEnableModal({ contract, onClose, onChanged }: ContractEnableModalProps) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Kept while the modal closes, so its content does not vanish mid-animation.
  const [shown, setShown] = useState<KnownContract | null>(contract);

  useEffect(() => {
    if (!contract) return;
    setShown(contract);
    setReason('');
    setSending(false);
    setRefusal(null);
  }, [contract]);

  if (!shown) return null;
  const enable = !shown.enabled;
  const kind = definitionName(shown.chain);

  async function change(event: FormEvent) {
    event.preventDefault();
    if (!shown) return;
    setSending(true);
    setRefusal(null);
    try {
      onChanged(await api.setContractEnabled(shown.id, enable, reason.trim() || undefined));
    } catch (failure) {
      setRefusal(assetRefusal(failure, { chain: shown.chain }));
      setSending(false);
    }
  }

  return (
    <Modal
      open={contract !== null}
      title={enable ? `Enable ${kind}` : `Disable ${kind}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it {shown.enabled ? 'enabled' : 'disabled'}
          </Button>
          <Button
            variant={enable ? 'primary' : 'danger'}
            type="submit"
            form="contract-enable-form"
            disabled={sending}
          >
            {sending ? 'Saving' : enable ? 'Enable' : 'Disable'}
          </Button>
        </>
      }
    >
      <div className={styles.cancelCard}>
        <div>
          <div className={styles.cancelName}>{shown.label}</div>
          <MonoValue value={shown.address} head={8} tail={6} />
        </div>
        <span className={styles.muted}>{CHAINS[shown.chain].label}</span>
      </div>
      <p className={styles.cancelText}>
        {enable
          ? `Calls to ${shown.label} and its events are explained by this ${kind} again, earlier ones included.`
          : `Calls to ${shown.label} show their raw data again, earlier ones included, until another ${kind} is added for this address. Nothing on chain changes.`}
      </p>
      <form
        id="contract-enable-form"
        className={ops.dialogField}
        onSubmit={(event) => void change(event)}
        noValidate
      >
        <TextArea
          label="Reason"
          data-autofocus
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          help="Optional. The activity record keeps it with this change."
        />
      </form>
      {refusal && (
        <div className={css.modalRefusal}>
          <RefusalNote refusal={refusal} />
        </div>
      )}
    </Modal>
  );
}
