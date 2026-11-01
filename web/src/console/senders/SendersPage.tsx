import { Amount } from '../../components/Amount';
import { Card } from '../../components/Card';
import { MonoValue } from '../../components/MonoValue';
import { type Chain, CHAINS } from '../../domain/chains';
import {
  type ForeignActivity,
  foreignNonces,
  free,
  HOLDER_LABEL,
  type Holding,
  isShort,
  MODE_LABEL,
  pinnedToMultisig,
  type Sender,
  senderKey,
} from '../../domain/sender';
import { describeFailure } from '../api/client';
import styles from '../console.module.css';
import { useSenders } from '../senderData';
import { PageBar } from '../Shell';

/** The Senders grouped by chain, in the order the engine lists them. */
function byChain(senders: readonly Sender[]): [Chain, Sender[]][] {
  const groups = new Map<Chain, Sender[]>();
  for (const sender of senders)
    groups.set(sender.chain, [...(groups.get(sender.chain) ?? []), sender]);
  return [...groups];
}

/** One card per Sender, grouped by enabled chain, from `GET /v1/senders` alone. */
export function SendersPage() {
  const { data, error } = useSenders();
  return (
    <main className={styles.main}>
      <PageBar title="Senders & Keys" />
      <div className={styles.pageBody}>
        {!data ? (
          <p className={styles.noRows}>
            {error ? describeFailure(error.failure) : 'Reading Senders, balances and Signer keys'}
          </p>
        ) : data.length === 0 ? (
          <p className={styles.noRows}>No chain is enabled on this engine (ENABLED_CHAINS).</p>
        ) : (
          byChain(data).map(([chain, senders]) => (
            <section key={chain} className={styles.chainGroup} aria-label={CHAINS[chain].label}>
              <h2 className={styles.chainHeading}>{CHAINS[chain].label}</h2>
              <div className={styles.senderCards}>
                {senders.map((sender) => (
                  <SenderPanel key={senderKey(sender)} sender={sender} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </main>
  );
}

function SenderPanel({ sender }: { sender: Sender }) {
  const { multisig } = sender;
  return (
    <Card
      title={sender.name}
      aside={
        sender.isDefault && (
          <span
            className={styles.defaultLabel}
            title="Pays for every Dispatch that names no Sender"
          >
            Default
          </span>
        )
      }
    >
      <dl className={styles.kv}>
        <div className={styles.kvRow}>
          <dt>Mode</dt>
          <dd>{MODE_LABEL[sender.mode]}</dd>
        </div>
        <div className={styles.kvRow}>
          <dt>
            {sender.mode === 'single' ? 'Sender' : sender.mode === 'squads' ? 'Vault' : 'Safe'}
          </dt>
          <dd>
            <MonoValue value={sender.address} head={8} tail={6} />
          </dd>
        </div>
        {multisig && sender.mode === 'squads' && (
          <div className={styles.kvRow}>
            <dt>Multisig</dt>
            <dd>
              <MonoValue value={multisig.address} head={8} tail={6} />
            </dd>
          </div>
        )}
        {multisig && (
          <>
            <div className={styles.kvRow}>
              <dt>Threshold</dt>
              <dd>
                {multisig.threshold.ok ? (
                  `${multisig.threshold.value} approvals to execute`
                ) : (
                  <span className={styles.fieldError}>Unread: {multisig.threshold.error}</span>
                )}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt>{sender.mode === 'squads' ? 'Member key' : 'Executor'}</dt>
              <dd>
                <MonoValue value={multisig.engineKey} head={8} tail={6} />
                <span className={styles.kvNote}> the engine&apos;s own key, never an Approver</span>
              </dd>
            </div>
          </>
        )}
      </dl>

      {sender.foreignActivity && <ForeignActivityNote activity={sender.foreignActivity} />}

      {sender.balances.map((holding) => (
        <BalanceTable key={holding.holder} holding={holding} />
      ))}

      <SignerBlock sender={sender} />
    </Card>
  );
}

/** ADR-0064: what the worker found another sender doing with this wallet, and what to do about it. */
function ForeignActivityNote({ activity }: { activity: ForeignActivity }) {
  return (
    <div className={styles.holding} role="note">
      <div className={styles.holdingHead}>
        <span className={styles.foreignTitle}>Another sender is using this wallet</span>
      </div>
      <p className={styles.foreignText}>
        Something other than this engine sent from this address in the last 24 hours. It used{' '}
        {foreignNonces(activity)}, the latest seen {activity.lastSeenAt.toLocaleString()}.
      </p>
      <p className={styles.foreignText}>
        When another sender takes a payment&apos;s nonce, the engine sends the payment again with a
        fresh nonce. Payments can then land out of order, and a payment fails with{' '}
        <code className={styles.code}>NONCE_ALREADY_USED</code> after 3 tries.
      </p>
      <p className={styles.foreignText}>
        Stop whatever else sends from this address, such as another engine, a wallet app or a
        script, or give this engine a Sender of its own. To split work, use named Senders in one
        engine.{' '}
        <a
          className={styles.proposalLink}
          href="/docs/self-hosting/configuration#one-engine-per-sender"
        >
          One engine per Sender ›
        </a>
      </p>
    </div>
  );
}

function BalanceTable({ holding }: { holding: Holding }) {
  return (
    <div className={styles.holding}>
      <div className={styles.holdingHead}>
        <span className={styles.holdingName}>{HOLDER_LABEL[holding.holder]}</span>
        <MonoValue value={holding.address} />
      </div>
      <table className={styles.balanceTable}>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Balance</th>
            <th scope="col">Committed</th>
            <th scope="col">Free</th>
          </tr>
        </thead>
        <tbody>
          {holding.assets.map((asset) => {
            const short = asset.balance.ok && isShort(asset.balance.value, asset.committed);
            return (
              <tr key={asset.asset} data-short={short || undefined}>
                <th scope="row">
                  {asset.asset}
                  {asset.committed.name !== asset.asset && (
                    <span className={styles.assetName}> {asset.committed.name}</span>
                  )}
                </th>
                <td>
                  {asset.balance.ok ? (
                    <Amount {...asset.balance.value} variant="plain" />
                  ) : (
                    <span className={styles.fieldError}>{asset.balance.error}</span>
                  )}
                </td>
                <td>
                  <Amount {...asset.committed} variant="plain" />
                </td>
                <td className={short ? styles.short : undefined}>
                  {asset.balance.ok ? (
                    <>
                      <Amount {...free(asset.balance.value, asset.committed)} variant="plain" />
                      {short && <span className={styles.shortNote}> below committed</span>}
                    </>
                  ) : (
                    <span className={styles.muted}>Unknown</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SignerBlock({ sender }: { sender: Sender }) {
  const pinned = pinnedToMultisig(sender);
  const target = sender.mode === 'safe' ? 'this Safe' : 'this multisig';
  return (
    <div className={styles.holding}>
      <div className={styles.holdingHead}>
        <span className={styles.holdingName}>Signer key</span>
      </div>
      {!sender.signerKey.ok ? (
        <p className={styles.fieldError}>Signer key: {sender.signerKey.error}.</p>
      ) : (
        <dl className={styles.kv}>
          <div className={styles.kvRow}>
            <dt>Key</dt>
            <dd>
              <MonoValue value={sender.signerKey.value.address} head={8} tail={6} />
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt>Last read</dt>
            <dd>{new Date(sender.signerKey.value.readAt).toLocaleString()}</dd>
          </div>
          <div className={styles.kvRow}>
            <dt>Curve</dt>
            <dd className={styles.mono}>{sender.signerKey.value.curve}</dd>
          </div>
          <div className={styles.kvRow}>
            <dt>Chain ids</dt>
            <dd>
              {sender.signerKey.value.chainIds.length > 0
                ? sender.signerKey.value.chainIds.join(', ')
                : 'Any'}
            </dd>
          </div>
          {sender.mode !== 'single' && (
            <div className={styles.kvRow}>
              <dt>Pinned to</dt>
              <dd>
                {(
                  sender.mode === 'safe'
                    ? sender.signerKey.value.allowedSafe
                    : sender.signerKey.value.allowedMultisig
                ) ? (
                  <MonoValue
                    value={
                      (sender.mode === 'safe'
                        ? sender.signerKey.value.allowedSafe
                        : sender.signerKey.value.allowedMultisig)!
                    }
                    head={8}
                    tail={6}
                  />
                ) : (
                  'Nothing'
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      {pinned === true && <p className={styles.pinOk}>Pinned to {target}</p>}
      {pinned === false && (
        <p className={styles.pinBad}>
          Not pinned to {target}. The engine will not start for a Multisig Sender whose key is
          unpinned or pinned elsewhere.
        </p>
      )}
    </div>
  );
}
