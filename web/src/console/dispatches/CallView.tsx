import { Amount } from '../../components/Amount';
import { MonoValue } from '../../components/MonoValue';
import { Pill } from '../../components/StatusPill';
import {
  type AmountView,
  argDisplay,
  callSignature,
  type CallArg,
  type DecodedCall,
  definitionName,
  type Effects,
  shortAddress,
  targetName,
  undecodedLine,
} from '../../domain/calls';
import type { Chain } from '../../domain/chains';
import type { CallItem, Item } from '../../domain/dispatch';
import styles from '../console.module.css';
import { Link } from '../router';
import { useOperator } from '../session';
import css from './calls.module.css';

/** Calls the Details tab draws in full; the rest are in Items. */
export const CALLS_IN_DETAILS = 20;

/** Where an operator registers the contract a call or event came from (ADR-0063). */
function addParams(chain: Chain, address: string): URLSearchParams {
  return new URLSearchParams({ chain, add: address });
}

/** "Add ABI" or "Add IDL", for an operator session only. */
export function AddDefinitionLink({ chain, address }: { chain: Chain; address: string }) {
  if (!useOperator()) return null;
  return (
    <Link page="contracts" params={addParams(chain, address)} className={css.addLink}>
      Add {definitionName(chain)}
    </Link>
  );
}

/** The address the registry would need to explain more of this item, if anything is unexplained. */
export function unexplainedAddress(item: CallItem): string | null {
  if (!item.call.decoded) return item.call.target;
  return item.effects?.undecodedEventSources.find((s) => s.label === null)?.source ?? null;
}

/** What the call is, in one cell of the Items table: the pill, the target and the function. */
export function CallCell({ item }: { item: CallItem }) {
  const { call } = item;
  return (
    <span className={css.cell} title={call.target}>
      <Pill tone="queued" label="Call" />
      <span className={css.cellTarget}>{targetName(call)}</span>
      <span className={css.cellFunction}>
        {call.function ?? (call.data ? 'unknown function' : 'no data')}
      </span>
    </span>
  );
}

function AmountText({ amount, unit }: { amount: AmountView; unit?: string }) {
  return amount.money ? (
    <Amount {...amount.money} variant="plain" unit tip={false} />
  ) : (
    <span>
      {amount.raw}
      {unit && <span className={styles.muted}> {unit}</span>}
    </span>
  );
}

/** "Deposited, fee 0.0000021 ETH": what an item's transaction changed, in a few words. */
function effectsSummary(chain: Chain, effects: Effects): string {
  const parts: string[] = [];
  const names = [...new Set(effects.events.map((e) => e.name))];
  if (names.length > 0) {
    parts.push(names.length > 3 ? `${names.slice(0, 3).join(', ')} and more` : names.join(', '));
  }
  if (effects.undecodedEvents > 0) parts.push(undecodedLine(chain, effects.undecodedEvents));
  return parts.join(', ');
}

/** The line under a call item in the Items table: its arguments, what it changed, and Add ABI. */
export function CallLine({ item, chain }: { item: CallItem; chain: Chain }) {
  const { call } = item;
  const signature = callSignature(call);
  const missing = unexplainedAddress(item);
  const changed = item.effects ? effectsSummary(chain, item.effects) : '';
  return (
    <span className={css.line}>
      <span className={css.lineCall} title={signature ?? call.data ?? undefined}>
        {signature ??
          (call.selector
            ? `Selector ${call.selector}, no ${definitionName(chain)}`
            : 'Sends value, no data')}
      </span>
      {changed && <span className={css.lineEffects}>{changed}</span>}
      {missing && <AddDefinitionLink chain={chain} address={missing} />}
    </span>
  );
}

function ArgRows({ args }: { args: readonly CallArg[] }) {
  return (
    <dl className={`${styles.kv} ${css.args}`}>
      {args.map((arg, index) => (
        <div key={`${arg.name}-${index}`} className={styles.kvRow}>
          <dt>{arg.name}</dt>
          <dd className={css.argValue}>
            {arg.money ? (
              <Amount {...arg.money} variant="plain" unit tip={false} />
            ) : typeof arg.value === 'string' &&
              (arg.type === 'address' || arg.type === 'pubkey') ? (
              <MonoValue value={arg.value} head={6} tail={4} />
            ) : (
              argDisplay(arg)
            )}
            <span className={css.argType}>{arg.type}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function What({ call, chain }: { call: DecodedCall; chain: Chain }) {
  if (call.function) {
    return (
      <>
        <p className={css.signature}>{call.function}</p>
        {call.args.length > 0 && <ArgRows args={call.args} />}
        {call.calls.length > 0 && (
          <ul className={css.effectList}>
            {call.calls.map((inner, index) => (
              <li key={index} className={css.effectRow}>
                <span className={css.eventName}>{targetName(inner)}</span>
                <span className={css.eventArgs}>
                  {callSignature(inner) ?? `selector ${inner.selector ?? 'none'}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (!call.data) return <p className={css.unknown}>Sends value only. It calls no function.</p>;
  return (
    <>
      <p className={css.unknown}>
        No {definitionName(chain)} explains this call
        {call.selector ? `, so it shows its selector ${call.selector} and raw data.` : '.'}{' '}
        <AddDefinitionLink chain={chain} address={call.target} />
      </p>
      <p className={css.raw}>{call.data}</p>
    </>
  );
}

function EffectsSection({
  effects,
  chain,
  status,
}: {
  effects: Effects | null;
  chain: Chain;
  status: Item['status'];
}) {
  if (!effects) {
    return status === 'confirmed' ? (
      <section className={css.section}>
        <h4 className={css.sectionTitle}>What it changed</h4>
        <p className={css.unknown}>Read from the chain a few seconds after it confirms.</p>
      </section>
    ) : null;
  }
  return (
    <section className={css.section}>
      <h4 className={css.sectionTitle}>What it changed</h4>
      <ul className={css.effectList}>
        {effects.transfers.map((t, index) => (
          <li key={`t-${index}`} className={css.effectRow}>
            <AmountText amount={t} {...(t.money ? {} : { unit: shortAddress(t.token) })} />
            <span className={styles.muted}>
              {t.from === null ? 'minted' : `from ${shortAddress(t.from)}`}
              {t.to === null ? ', burned' : ` to ${shortAddress(t.to)}`}
            </span>
          </li>
        ))}
        {effects.events.map((event, index) => (
          <li key={`e-${index}`} className={css.effectRow}>
            <span className={css.eventName}>{event.name}</span>
            <span className={styles.muted}>{event.label ?? shortAddress(event.source)}</span>
            {event.args.length > 0 && (
              <span className={css.eventArgs}>
                {event.args.map((a) => `${a.name}: ${argDisplay(a)}`).join(', ')}
              </span>
            )}
          </li>
        ))}
        {effects.undecodedEventSources.map((source) => (
          <li key={`u-${source.source}`} className={css.effectRow}>
            <span>
              {undecodedLine(chain, source.count)}, from{' '}
              {source.label ?? shortAddress(source.source)}
            </span>
            <AddDefinitionLink chain={chain} address={source.source} />
          </li>
        ))}
        <li className={css.effectRow}>
          <span className={styles.muted}>Fee</span>
          <AmountText amount={effects.fee} />
          <span className={styles.muted}>paid by {shortAddress(effects.fee.payer)}</span>
        </li>
      </ul>
      {effects.truncated && (
        <p className={css.unknown}>
          Part of what it did was too large to store, so this is not all of it.
        </p>
      )}
    </section>
  );
}

function CallCard({
  item,
  chain,
  sharedWith,
}: {
  item: CallItem;
  chain: Chain;
  /** The first call shown with the same transaction, whose card already has its effects. */
  sharedWith: number | null;
}) {
  const { call } = item;
  return (
    <article className={css.call} aria-label={`Call ${item.index + 1}`}>
      <div className={css.callHead}>
        <Pill tone="queued" label="Call" />
        <span className={css.callName}>{targetName(call)}</span>
        <span className={css.callAddress}>
          <MonoValue value={call.target} head={6} tail={4} />
        </span>
      </div>
      <What call={call} chain={chain} />
      {call.value && (
        <dl className={`${styles.kv} ${css.args}`}>
          <div className={styles.kvRow}>
            <dt>Value</dt>
            <dd>
              <AmountText amount={call.value} />
            </dd>
          </div>
        </dl>
      )}
      {sharedWith === null ? (
        <EffectsSection effects={item.effects} chain={chain} status={item.status} />
      ) : (
        <p className={css.unknown}>
          Same transaction as item {sharedWith + 1}, whose effects are shown above.
        </p>
      )}
    </article>
  );
}

/** The Details tab's calls: each with its function, arguments, value and what it changed. */
export function CallDetails({ items, chain }: { items: readonly Item[]; chain: Chain }) {
  const calls = items.filter((item): item is CallItem => item.type === 'call');
  if (calls.length === 0) return null;
  const firstWith = new Map<string, number>();
  const shown = calls.slice(0, CALLS_IN_DETAILS);
  return (
    <div className={css.calls}>
      <h3 className={styles.detailsHeading}>{calls.length === 1 ? 'Call' : 'Calls'}</h3>
      {shown.map((item) => {
        const hash = item.transactionHash;
        const first = hash === null ? undefined : firstWith.get(hash);
        if (hash !== null && first === undefined) firstWith.set(hash, item.index);
        return <CallCard key={item.index} item={item} chain={chain} sharedWith={first ?? null} />;
      })}
      {calls.length > shown.length && (
        <p className={css.unknown}>{calls.length - shown.length} more calls are in Items.</p>
      )}
    </div>
  );
}
