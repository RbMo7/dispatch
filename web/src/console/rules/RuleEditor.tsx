import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { DockedPane } from '../../components/DockedPane';
import { Select, TextArea } from '../../components/Field';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Switch } from '../../components/Switch';
import { TextField } from '../../components/TextField';
import { CHAINS, type Chain } from '../../domain/chains';
import { shortId } from '../../domain/dispatch';
import {
  describeCheck,
  draftBody,
  type DraftField,
  draftOf,
  type FlagRule,
  newDraft,
  type Preview,
  RULE_KIND_NAMES,
  RULE_KINDS,
  type RuleDraft,
} from '../../domain/flagRules';
import { payer, type Sender } from '../../domain/sender';
import { ApiError, describeFailure } from '../api/client';
import styles from '../console.module.css';
import ops from '../operator.module.css';
import { Link } from '../router';
import { useApi } from '../session';

const count = new Intl.NumberFormat('en-US');
const day = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A preview waits this long after the last keystroke, so typing a limit costs one request. */
const PREVIEW_DEBOUNCE_MS = 400;

/** The assets a rule on `chain` can name: every one its Senders pay in, native first. */
function assetsOn(senders: readonly Sender[], chain: Chain): string[] {
  const names = senders
    .filter((sender) => sender.chain === chain)
    .flatMap((sender) => payer(sender)?.assets.map((a) => a.asset) ?? []);
  return [...new Set(names)];
}

type PreviewState =
  | { kind: 'incomplete'; message: string }
  | { kind: 'loading' }
  | { kind: 'ready'; preview: Preview }
  | { kind: 'refused'; message: string };

function usePreview(draft: RuleDraft): PreviewState {
  const api = useApi();
  const body = useMemo(() => draftBody(draft, { forPreview: true }), [draft]);
  const key = body.ok ? JSON.stringify(body.body) : null;
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });

  useEffect(() => {
    if (!body.ok) {
      setState({ kind: 'incomplete', message: body.message });
      return;
    }
    setState({ kind: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.previewFlagRule(body.body, controller.signal).then(
        (preview) => setState({ kind: 'ready', preview }),
        (error: unknown) => {
          if (controller.signal.aborted || !(error instanceof ApiError)) return;
          setState({ kind: 'refused', message: describeFailure(error.failure) });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `key` stands for `body`: a new object with the same content must not preview again.
  }, [api, key]);

  return state;
}

interface RuleEditorProps {
  /** Null for a new rule. */
  rule: FlagRule | null;
  senders: readonly Sender[];
  onClose: () => void;
  onSaved: (rule: FlagRule, created: boolean) => void;
}

/** The right pane: a rule's fields, a live preview over the last 30 days, and its versions. */
export function RuleEditor({ rule, senders, onClose, onSaved }: RuleEditorProps) {
  const api = useApi();
  const chains = useMemo(() => [...new Set(senders.map((s) => s.chain))], [senders]);
  const [draft, setDraft] = useState<RuleDraft>(() => {
    if (rule) return draftOf(rule);
    const chain = chains[0] ?? 'solana';
    return newDraft(chain, assetsOn(senders, chain)[0] ?? '');
  });
  const [problem, setProblem] = useState<{ field: DraftField | null; message: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const preview = usePreview(draft);

  const assets = assetsOn(senders, draft.chain);
  const senderNames = senders.filter((s) => s.chain === draft.chain).map((s) => s.name);
  const params = RULE_KINDS[draft.kind].params;
  const change = (patch: Partial<RuleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const changeChain = (chain: Chain) =>
    change({
      chain,
      sender: null,
      asset: assetsOn(senders, chain).includes(draft.asset)
        ? draft.asset
        : (assetsOn(senders, chain)[0] ?? ''),
    });

  async function save(event: FormEvent) {
    event.preventDefault();
    const body = draftBody(draft);
    if (!body.ok) {
      setProblem({ field: body.field, message: body.message });
      return;
    }
    setSaving(true);
    try {
      const saved = rule
        ? await api.updateFlagRule(rule.id, body.body)
        : await api.createFlagRule(body.body);
      onSaved(saved, rule === null);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setProblem({ field: null, message: describeFailure(error.failure) });
      setSaving(false);
    }
  }

  const fieldError = (field: DraftField) => (problem?.field === field ? problem.message : null);

  return (
    <DockedPane
      title={rule ? 'Edit Flag Rule' : 'New Flag Rule'}
      meta={rule && <span className={styles.muted}>Version {rule.current.version}</span>}
      label="Flag Rule editor"
      onClose={onClose}
      footer={
        <div className={ops.footerActions}>
          <Button variant="secondary" onClick={onClose}>
            Discard
          </Button>
          <Button variant="primary" type="submit" form="rule-form" disabled={saving}>
            {saving
              ? 'Saving'
              : rule
                ? `Save as version ${rule.current.version + 1}`
                : 'Create rule'}
          </Button>
        </div>
      }
    >
      <form id="rule-form" className={ops.editor} onSubmit={(event) => void save(event)} noValidate>
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => change({ name: event.target.value })}
          placeholder="Large USDC payment"
          aria-invalid={fieldError('name') ? true : undefined}
          help={fieldError('name') ?? 'Shown in the Held queue and on each hold.'}
        />
        {chains.length > 1 && (
          <div>
            <div className={ops.fieldLabel}>Chain</div>
            <SegmentedControl
              label="Chain"
              options={chains.map((chain) => ({ value: chain, label: CHAINS[chain].label }))}
              value={draft.chain}
              onChange={changeChain}
            />
          </div>
        )}
        {senderNames.length > 1 && (
          <Select
            label="Sender"
            value={draft.sender ?? ''}
            onChange={(event) => change({ sender: event.target.value || null })}
            options={[
              { value: '', label: `Every Sender on ${CHAINS[draft.chain].label}` },
              ...senderNames.map((name) => ({ value: name, label: `${name} only` })),
            ]}
            help="A rule for one Sender checks only the Dispatches it pays."
          />
        )}
        <Select
          label="Hold when"
          value={draft.kind}
          onChange={(event) => change({ kind: event.target.value as RuleDraft['kind'] })}
          options={RULE_KIND_NAMES.map((kind) => ({ value: kind, label: RULE_KINDS[kind].label }))}
        />
        {params === 'limit' && (
          <div className={ops.editorPair}>
            <Select
              label="Asset"
              value={draft.asset}
              onChange={(event) => change({ asset: event.target.value })}
              options={assets.map((asset) => ({ value: asset, label: asset }))}
            />
            <TextField
              label="Limit"
              inputMode="decimal"
              value={draft.limit}
              onChange={(event) => change({ limit: event.target.value })}
              placeholder="5000"
              aria-invalid={fieldError('limit') ? true : undefined}
              help={
                fieldError('limit') ?? `Whole ${draft.asset || 'units'}, not the smallest unit.`
              }
            />
          </div>
        )}
        {params === 'list' && (
          <TextArea
            label="Addresses"
            rows={4}
            value={draft.addresses}
            onChange={(event) => change({ addresses: event.target.value })}
            error={fieldError('addresses')}
            help="One per line. Anything not listed is held."
          />
        )}
        <label className={ops.enabledLine}>
          <Switch
            checked={draft.enabled}
            label="Rule on"
            onChange={(enabled) => change({ enabled })}
          />
          {draft.enabled ? 'On: checks every new Dispatch' : 'Off: kept, but checks nothing'}
        </label>
        <TextField
          label="Reason"
          value={draft.reason}
          onChange={(event) => change({ reason: event.target.value })}
          help="Optional. The activity record keeps it with this change."
        />
        <PreviewCard state={preview} />
        {problem && problem.field === null && (
          <p className={ops.formError} role="alert">
            {problem.message}
          </p>
        )}
      </form>
      {rule && <History rule={rule} />}
    </DockedPane>
  );
}

function PreviewCard({ state }: { state: PreviewState }) {
  return (
    <section className={ops.preview} aria-label="Preview" aria-live="polite">
      <div className={ops.previewHead}>
        <span>Preview, last 30 days</span>
        {state.kind === 'ready' && state.preview.capped && <span>Latest 2,000 only</span>}
      </div>
      {state.kind === 'ready' ? (
        <>
          <div className={ops.previewNumber}>{count.format(state.preview.wouldHold)}</div>
          <p className={ops.previewLine}>
            {state.preview.wouldHold === 1 ? 'Dispatch' : 'Dispatches'} of{' '}
            {count.format(state.preview.scanned)} would have been held.
          </p>
          {state.preview.examples.length > 0 && (
            <ul className={ops.previewExamples}>
              {state.preview.examples.slice(0, 6).map((example) => (
                <li key={example.dispatchId}>
                  <Link
                    page="dispatches"
                    params={new URLSearchParams({ dispatch: example.dispatchId })}
                  >
                    {shortId(example.dispatchId)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className={ops.previewLine}>
          {state.kind === 'loading'
            ? 'Checking the last 30 days.'
            : state.kind === 'incomplete'
              ? `${state.message} The preview follows.`
              : state.message}
        </p>
      )}
    </section>
  );
}

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** Every version, newest first: rules are forward-only, so a hold always names the one it matched. */
function History({ rule }: { rule: FlagRule }) {
  return (
    <section className={ops.section}>
      <h3 className={ops.sectionTitle}>Versions</h3>
      <ol className={ops.history}>
        {[...rule.versions].reverse().map((version) => (
          <li key={version.version} className={ops.historyRow}>
            <span className={ops.historyVersion}>{version.version}</span>
            <span>
              {version.name}: {lowerFirst(describeCheck(version.check, version.chain))}
              {version.sender && `, ${version.sender.name ?? 'a removed Sender'} only`}
              {version.enabled ? '' : ', off'}
            </span>
            <span className={ops.historyWhen}>{day.format(version.createdAt)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
