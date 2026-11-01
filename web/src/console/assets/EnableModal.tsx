import { type FormEvent, useEffect, useState } from 'react';

import { Button } from '../../components/Button';
import { TextArea } from '../../components/Field';
import { MonoValue } from '../../components/MonoValue';
import { type AssetRefusal, explainAssetRefusal, type KnownAsset } from '../../domain/assets';
import { CHAINS } from '../../domain/chains';
import { Modal } from '../../motion/Overlay';
import { ApiError, describeFailure } from '../api/client';
import styles from '../console.module.css';
import ops from '../operator.module.css';
import { useApi } from '../session';
import css from './assets.module.css';
import { RefusalNote } from './RefusalNote';

interface EnableModalProps {
  /** The asset to flip, or null while closed. */
  asset: KnownAsset | null;
  onClose: () => void;
  onChanged: (asset: KnownAsset) => void;
}

/** One decision: stop new payments naming an asset, or let them again. */
export function EnableModal({ asset, onClose, onChanged }: EnableModalProps) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<AssetRefusal | null>(null);
  // Kept while the modal closes, so its content does not vanish mid-animation.
  const [shown, setShown] = useState<KnownAsset | null>(asset);

  useEffect(() => {
    if (!asset) return;
    setShown(asset);
    setReason('');
    setSending(false);
    setRefusal(null);
  }, [asset]);

  if (!shown) return null;
  const enable = !shown.enabled;
  const chain = CHAINS[shown.chain].label;

  async function change(event: FormEvent) {
    event.preventDefault();
    if (!shown) return;
    setSending(true);
    setRefusal(null);
    try {
      onChanged(await api.setAssetEnabled(shown.id, enable, reason.trim() || undefined));
    } catch (failure) {
      if (!(failure instanceof ApiError)) throw failure;
      setRefusal(
        failure.failure.kind === 'refused'
          ? explainAssetRefusal(failure.failure, {
              chain: shown.chain,
              change: enable ? 'enable' : 'disable',
            })
          : { text: describeFailure(failure.failure), detail: null },
      );
      setSending(false);
    }
  }

  return (
    <Modal
      open={asset !== null}
      title={enable ? 'Enable asset' : 'Disable asset'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it {shown.enabled ? 'enabled' : 'disabled'}
          </Button>
          <Button
            variant={enable ? 'primary' : 'danger'}
            type="submit"
            form="asset-enable-form"
            disabled={sending}
          >
            {sending ? 'Saving' : enable ? `Enable ${shown.symbol}` : `Disable ${shown.symbol}`}
          </Button>
        </>
      }
    >
      <div className={styles.cancelCard}>
        <div>
          <div className={styles.cancelName}>
            {shown.name} <span className={styles.muted}>{shown.symbol}</span>
          </div>
          <MonoValue value={shown.address} head={8} tail={6} />
        </div>
        <span className={styles.muted}>{chain}</span>
      </div>
      <p className={styles.cancelText}>
        {enable
          ? `Payments on ${chain} can name ${shown.symbol} again as soon as it is enabled.`
          : `No new payment on ${chain} can name ${shown.symbol} once it is disabled. Payments already accepted still go out, and past Dispatches keep their amounts. You can enable it again.`}
      </p>
      <form
        id="asset-enable-form"
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
