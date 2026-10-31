import type { Money } from './assets';
import type { Chain } from './chains';
import type { Flow } from './flow';
import type { Status } from './status';

export type Mode = 'managed' | 'relay';

export interface DispatchSummary {
  id: string;
  label: string | null;
  mode: Mode;
  chain: Chain;
  status: Status;
  createdAt: Date;
  itemCount: number;
  totals: Money[];
}

export type ItemStatus = Extract<
  Status,
  'queued' | 'awaiting_approval' | 'broadcasting' | 'confirmed' | 'failed' | 'abandoned' | 'cancelled'
>;

interface ItemBase {
  index: number;
  status: ItemStatus;
  transactionHash: string | null;
  error: { code: string; message: string } | null;
}

export interface PaymentItem extends ItemBase {
  type: 'payment';
  recipient: string;
  amount: Money;
}

export interface CallItem extends ItemBase {
  type: 'call';
  target: string;
  amount: Money | null;
}

export type Item = PaymentItem | CallItem;

export function itemTarget(item: Item): string {
  return item.type === 'payment' ? item.recipient : item.target;
}

export interface DispatchDetail extends DispatchSummary {
  sender: string;
  retryPolicy: string;
  bulkCall: string;
  claimedAt: Date | null;
  idempotencyKey: string;
  flow: Flow;
  items: Item[];
}
