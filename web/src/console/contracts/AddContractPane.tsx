import { type FormEvent, useState } from 'react';

import { Button } from '../../components/Button';
import { DockedPane } from '../../components/DockedPane';
import { TextArea } from '../../components/Field';
import { MonoValue } from '../../components/MonoValue';
import { TextField } from '../../components/TextField';
import { definitionName } from '../../domain/calls';
import { CHAINS, type Chain } from '../../domain/chains';
import type { ContractPreview, ContractRequest, KnownContract } from '../../domain/contracts';
import { assetRefusal, type Refusal, RefusalNote } from '../assets/RefusalNote';
import styles from '../console.module.css';
import ops from '../operator.module.css';
import { useApi } from '../session';
import css from './contracts.module.css';

/** A preview is only good for the request it was read for. */
type Step =
  | { kind: 'editing' }
  | { kind: 'reading' }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'previewed'; preview: ContractPreview; adding: boolean };

interface AddContractPaneProps {
  chain: Chain;
  /** Filled in from the call whose "Add ABI" opened the pane. */
  address: string;
  onClose: () => void;
  onAdded: (contract: KnownContract) => void;
}

/** Paste an ABI or IDL, see what it explains, then register it (ADR-0063). */
export function AddContractPane({
  chain,
  address: initial,
  onClose,
  onAdded,
}: AddContractPaneProps) {
  const api = useApi();
  const [address, setAddress] = useState(initial);
  const [label, setLabel] = useState('');
  const [definition, setDefinition] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'editing' });
  const chainLabel = CHAINS[chain].label;
  const kind = definitionName(chain);
  const request: ContractRequest = {
    chain,
    address: address.trim(),
    label: label.trim(),
    definition,
  };
  const ready = request.address !== '' && request.label !== '' && definition.trim() !== '';

  const refusalOf = (failure: unknown) => assetRefusal(failure, { chain });

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setStep({ kind: 'reading' });
    try {
      setStep({ kind: 'previewed', preview: await api.previewContract(request), adding: false });
    } catch (failure) {
      setStep({ kind: 'refused', refusal: refusalOf(failure) });
    }
  }

  async function add() {
    if (step.kind !== 'previewed') return;
    setStep({ ...step, adding: true });
    try {
      onAdded(await api.addContract(request));
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
      title={`Add ${kind}`}
      meta={<span className={styles.muted}>{chainLabel}</span>}
      label={`Add a contract on ${chainLabel}`}
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
              {step.kind === 'previewed' && step.adding ? 'Adding' : `Add ${kind}`}
            </Button>
          </span>
        </>
      }
    >
      <form className={ops.editor} onSubmit={(event) => void preview(event)} noValidate>
        <TextField
          label={chain === 'solana' ? 'Program address' : 'Contract address'}
          autoFocus={initial === ''}
          style={{ fontFamily: 'var(--font-mono)' }}
          spellCheck={false}
          autoComplete="off"
          value={address}
          onChange={(event) => edit(setAddress, event.target.value)}
        />
        <TextField
          label="Label"
          autoFocus={initial !== ''}
          autoComplete="off"
          maxLength={64}
          value={label}
          onChange={(event) => edit(setLabel, event.target.value)}
          help="What calls to it are shown as, such as FlowVault."
        />
        <TextArea
          label={chain === 'solana' ? 'Anchor IDL' : 'ABI'}
          rows={10}
          spellCheck={false}
          className={css.definition}
          value={definition}
          onChange={(event) => edit(setDefinition, event.target.value)}
          help={
            chain === 'solana'
              ? 'The IDL file Anchor wrote, as JSON.'
              : 'The ABI as JSON: the array, or the whole compiler artifact.'
          }
        />
        <div>
          <Button variant="secondary" type="submit" disabled={!ready || step.kind === 'reading'}>
            {step.kind === 'reading' ? 'Reading' : 'Preview'}
          </Button>
        </div>
        {step.kind === 'refused' && <RefusalNote refusal={step.refusal} />}
        {step.kind === 'previewed' && <PreviewCard preview={step.preview} />}
      </form>
    </DockedPane>
  );
}

function PreviewCard({ preview }: { preview: ContractPreview }) {
  const solana = preview.chain === 'solana';
  return (
    <section className={ops.preview} aria-label="What it explains">
      <div className={ops.previewHead}>
        <span>What it explains</span>
        <MonoValue value={preview.address} head={6} tail={4} />
      </div>
      <h4 className={css.listTitle}>
        {preview.functions.length} {solana ? 'instruction' : 'function'}
        {preview.functions.length === 1 ? '' : 's'}
      </h4>
      <ul className={css.signatures}>
        {preview.functions.map((signature) => (
          <li key={signature}>{signature}</li>
        ))}
      </ul>
      {!solana && (
        <>
          <h4 className={css.listTitle}>
            {preview.events.length} event{preview.events.length === 1 ? '' : 's'}
          </h4>
          <ul className={css.signatures}>
            {preview.events.map((signature) => (
              <li key={signature}>{signature}</li>
            ))}
          </ul>
        </>
      )}
      <p className={css.note}>
        Calls to {preview.label} are explained as soon as it is added, earlier ones included.
      </p>
    </section>
  );
}
