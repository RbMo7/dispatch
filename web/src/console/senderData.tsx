import { createContext, type ReactNode, useCallback, useContext } from 'react';

import { truncateMiddle } from '../components/MonoValue';
import { SenderCard, type SenderCardProps } from '../components/SenderCard';
import {
  feePayer,
  headlineAsset,
  HOLDER_LABEL,
  payer,
  pinnedToMultisig,
  type Sender,
  signingLine,
} from '../domain/sender';
import { describeFailure } from './api/client';
import styles from './console.module.css';
import { type Polled, SENDERS_MS, usePoll } from './live';
import { PAGES } from './router';
import { useApi } from './session';

const SendersContext = createContext<Polled<Sender[]> | null>(null);

/** `GET /v1/senders` every 15 s, shared by the sidebar, the Overview and Senders & Keys. */
export function SendersProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => api.listSenders(signal), [api]);
  const polled = usePoll({ key: 'senders', load, delay: () => SENDERS_MS });
  return <SendersContext.Provider value={polled}>{children}</SendersContext.Provider>;
}

export function useSenders(): Polled<Sender[]> {
  const senders = useContext(SendersContext);
  if (!senders) throw new Error('useSenders outside SendersProvider');
  return senders;
}

export const SENDER_NAME: Record<Sender['mode'], string> = {
  single: 'Sender',
  squads: 'Squads vault',
  safe: 'Safe',
};

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
    name: `${SENDER_NAME[sender.mode]} ${truncateMiddle(sender.address, 4, 4)}`,
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
        key={sender.chain}
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
