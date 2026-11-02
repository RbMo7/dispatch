import { SenderCard } from '../../components/SenderCard';
import { DISPATCHES, money } from '../fixtures';
import { Sidebar } from '../Sidebar';

const HELD = DISPATCHES.filter((d) => d.status === 'held').length;

/** The console's sidebar with the board's two recorded Sender cards; `operator` adds the operator pages and the held count. */
export function GallerySidebar({ operator = false }: { operator?: boolean }) {
  return (
    <Sidebar
      current="dispatches"
      operator={operator}
      held={operator ? HELD : null}
      instance="dispatch-eu-1"
      connection="live"
      senders={
        <>
          <SenderCard
            chain="solana"
            signing="Squads, 2 to approve"
            name="Treasury vault"
            balance={money('1842.30', 'USDC')}
            committed={money('700.00', 'USDC')}
            needed={money('420.00', 'USDC')}
            footer={{ label: 'Fees from member key', fee: money('0.4182', 'SOL') }}
            href="#senders"
          />
          <SenderCard
            chain="base"
            signing="Single key"
            name="Payouts sender"
            balance={money('0.8412', 'ETH')}
            committed={money('0.7650', 'ETH')}
            needed={money('0.1200', 'ETH')}
            footer={{ label: 'Signer key', text: 'secp256k1' }}
            href="#senders"
          />
        </>
      }
    />
  );
}
