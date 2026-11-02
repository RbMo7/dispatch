import { type FormEvent, useState } from 'react';

import { Button } from '../../components/Button';
import { DockedPane } from '../../components/DockedPane';
import { MonoValue } from '../../components/MonoValue';
import { TextField } from '../../components/TextField';
import { ASSET_KINDS, type AssetPreview, formatAmount, type KnownAsset } from '../../domain/assets';
import { CHAINS, type Chain } from '../../domain/chains';
import type { AssetRequest } from '../api/client';
import styles from '../console.module.css';
import ops from '../operator.module.css';
import { useApi } from '../session';
import css from './assets.module.css';
import { assetRefusal, type Refusal, RefusalNote } from './RefusalNote';

/** Where the form is: a preview is only good for the address and symbol it was read for. */
type Step =
  | { kind: 'editing' }
  | { kind: 'reading' }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'previewed'; preview: AssetPreview; adding: boolean };

interface AddAssetPaneProps {
  chain: Chain;
  /** Filled in from the link that opened the pane, such as a refused payment's asset. */
  address: string;
  symbol: string;
  onClose: () => void;
  onAdded: (asset: KnownAsset) => void;
}

/** Paste an address, see what the chain says it is, then add it (ADR-0061). */
export function AddAssetPane({
  chain,
  address: initial,
  symbol: named,
  onClose,
  onAdded,
}: AddAssetPaneProps) {
  const api = useApi();
  const [address, setAddress] = useState(initial);
  const [symbol, setSymbol] = useState(named);
  const [step, setStep] = useState<Step>({ kind: 'editing' });
  const label = CHAINS[chain].label;
  const request: AssetRequest = {
    chain,
    address: address.trim(),
    ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
  };

  const refusalOf = (failure: unknown): Refusal =>
    assetRefusal(failure, { chain, asset: { change: 'add', symbol: request.symbol } });

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!request.address) return;
    setStep({ kind: 'reading' });
    try {
      setStep({ kind: 'previewed', preview: await api.previewAsset(request), adding: false });
    } catch (failure) {
      setStep({ kind: 'refused', refusal: refusalOf(failure) });
    }
  }

  async function add() {
    if (step.kind !== 'previewed') return;
    setStep({ ...step, adding: true });
    try {
      onAdded(await api.addAsset(request));
    } catch (failure) {
      setStep({ kind: 'refused', refusal: refusalOf(failure) });
    }
  }

  const edit = (set: (value: string) => void, value: string) => {
    set(value);
    setStep({ kind: 'editing' });
  };

  return (
    <DockedPane
      title="Add asset"
      meta={<span className={styles.muted}>{label}</span>}
      label={`Add an asset on ${label}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <span className={styles.pushRight}>
            <Button
              variant="primary"
              disabled={step.kind !== 'previewed' || step.adding}
              onClick={() => void add()}
            >
              {step.kind === 'previewed'
                ? step.adding
                  ? 'Adding'
                  : `Add ${step.preview.symbol}`
                : 'Add asset'}
            </Button>
          </span>
        </>
      }
    >
      <form className={ops.editor} onSubmit={(event) => void preview(event)} noValidate>
        <TextField
          label={chain === 'solana' ? 'Mint address' : 'Contract address'}
          autoFocus
          style={{ fontFamily: 'var(--font-mono)' }}
          spellCheck={false}
          autoComplete="off"
          value={address}
          onChange={(event) => edit(setAddress, event.target.value)}
          help={`The token's ${chain === 'solana' ? 'mint' : 'contract'} on ${label}. Its name, symbol and decimals are read from the chain.`}
        />
        <TextField
          label="Symbol"
          spellCheck={false}
          autoComplete="off"
          value={symbol}
          onChange={(event) => edit(setSymbol, event.target.value)}
          help="Optional. Replaces the token's own symbol when it has none, or when another asset on this chain already uses it."
        />
        <div>
          <Button
            variant="secondary"
            type="submit"
            disabled={!request.address || step.kind === 'reading'}
          >
            {step.kind === 'reading' ? `Reading ${label}` : 'Preview'}
          </Button>
        </div>
        {step.kind === 'refused' && <RefusalNote refusal={step.refusal} />}
        {step.kind === 'previewed' && <PreviewCard preview={step.preview} />}
      </form>
    </DockedPane>
  );
}

function PreviewCard({ preview }: { preview: AssetPreview }) {
  const { onChain } = preview;
  const supply = formatAmount({
    raw: preview.supply,
    decimals: preview.decimals,
    asset: preview.symbol,
  });
  return (
    <section className={ops.preview} aria-label="What the chain says">
      <div className={ops.previewHead}>
        <span>What the chain says</span>
        <span>{ASSET_KINDS[preview.kind]}</span>
      </div>
      <dl className={`${styles.kv} ${css.previewList}`}>
        <div className={styles.kvRow}>
          <dt>Name</dt>
          <dd>
            {preview.name}
            {onChain.name === '' && (
              <div className={css.note}>The token publishes no name, so it takes its symbol.</div>
            )}
          </dd>
        </div>
        <div className={styles.kvRow}>
          <dt>Symbol</dt>
          <dd>
            {preview.symbol}
            {onChain.symbol !== '' && onChain.symbol !== preview.symbol && (
              <div className={css.note}>The chain gives {onChain.symbol}.</div>
            )}
          </dd>
        </div>
        <div className={styles.kvRow}>
          <dt>Decimals</dt>
          <dd>{preview.decimals}</dd>
        </div>
        <div className={styles.kvRow}>
          <dt>Supply</dt>
          <dd className={css.figure}>
            {supply} {preview.symbol}
          </dd>
        </div>
        <div className={styles.kvRow}>
          <dt>Address</dt>
          <dd>
            <MonoValue value={preview.address} head={8} tail={6} />
          </dd>
        </div>
      </dl>
    </section>
  );
}
