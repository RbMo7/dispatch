import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';

import { SenderCard, type SenderCardProps } from '../components/SenderCard';
import {
  feePayer,
  foreignNonces,
  headlineAsset,
  HOLDER_LABEL,
  payer,
  pinnedToMultisig,
  type Sender,
  senderKey,
  sharedChains,
  signingLine,
} from '../domain/sender';
import type { KnownAsset } from '../domain/assets';
import type { Chain } from '../domain/chains';
import { describeFailure } from './api/client';
import styles from './console.module.css';
import { type Polled, SENDERS_MS, usePoll } from './live';
import { PAGES } from './router';
import { useApi } from './session';

const SendersContext = createContext<Polled<Sender[]> | null>(null);
const AssetsContext = createContext<Polled<KnownAsset[]> | null>(null);

/**
 * `GET /v1/assets` then `GET /v1/senders`, every 15 s, shared by the sidebar,
 * the Overview, Senders & Keys and Assets. Reading the assets first also
 * refreshes the names every amount is shown by.
 */
export function SendersProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const assets = await api.listAssets(signal);
      return { assets, senders: await api.listSenders(signal) };
    },
    [api],
  );
  const { data, error, reload } = usePoll({ key: 'senders', load, delay: () => SENDERS_MS });
  const senders = useMemo(() => ({ data: data?.senders, error, reload }), [data, error, reload]);
  const assets = useMemo(() => ({ data: data?.assets, error, reload }), [data, error, reload]);
  return (
    <SendersContext.Provider value={senders}>
      <AssetsContext.Provider value={assets}>{children}</AssetsContext.Provider>
    </SendersContext.Provider>
  );
}

export function useSenders(): Polled<Sender[]> {
  const senders = useContext(SendersContext);
  if (!senders) throw new Error('useSenders outside SendersProvider');
  return senders;
}

/** Every Known Asset, enabled or not, on every chain. */
export function useAssets(): Polled<KnownAsset[]> {
  const assets = useContext(AssetsContext);
  if (!assets) throw new Error('useAssets outside SendersProvider');
  return assets;
}

/** The chains this engine has enabled: every one has at least one Sender, so they are exactly the Senders' chains. */
export function useEnabledChains(): Chain[] {
  const { data } = useSenders();
  return useMemo(() => [...new Set((data ?? []).map((sender) => sender.chain))], [data]);
}

/** The enabled chains with more than one Sender. */
export function useSharedChains(): Set<Chain> {
  const { data } = useSenders();
  return useMemo(() => sharedChains(data ?? []), [data]);
}

/** One Sender as a sidebar card: its headline balance, what is committed, and who pays fees. */
export function senderCard(sender: Sender): Omit<SenderCardProps, 'href'> | null {
  const holding = payer(sender);
  const headline = holding && headlineAsset(holding);
  if (!holding || !headline) return null;
  const fees = feePayer(sender);
  const feeAsset = fees?.assets[0];
  const pinned = pinnedToMultisig(sender);
  return {
    chain: sender.chain,
    signing: signingLine(sender),
    name: sender.name,
    balance: headline.balance.ok ? headline.balance.value : { error: headline.balance.error },
    committed: headline.committed,
    footer:
      fees && feeAsset?.balance.ok
        ? {
            label: `Fees from ${HOLDER_LABEL[fees.holder].toLowerCase()}`,
            fee: feeAsset.balance.value,
          }
        : {
            label: 'Signer key',
            text: !sender.signerKey.ok
              ? 'Unreachable'
              : pinned === false
                ? 'Not pinned'
                : `${sender.signerKey.value.curve}${pinned ? ', pinned' : ''}`,
          },
    ...(sender.foreignActivity && {
      warning: `Another sender used ${foreignNonces(sender.foreignActivity)}`,
    }),
  };
}

export function SidebarSenders({ onOpen }: { onOpen: () => void }) {
  const { data, error } = useSenders();
  if (!data) {
    return (
      <p className={styles.sidebarNote}>
        {error ? describeFailure(error.failure) : 'Reading Senders'}
      </p>
    );
  }
  if (data.length === 0) return <p className={styles.sidebarNote}>No chain is enabled.</p>;
  return data.map((sender) => {
    const card = senderCard(sender);
    return card ? (
      <SenderCard
        key={senderKey(sender)}
        {...card}
        href={PAGES.senders}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          onOpen();
        }}
      />
    ) : null;
  });
}
