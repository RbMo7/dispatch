import { type BaseEffects, EFFECTS_BOUNDS } from '../../domain/effects.js';

/** `eth_getTransactionReceipt`'s answer, as much of it as the effects need. Quantities are hex. */
export type RawReceipt = {
  blockNumber: string;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice: string;
  /** OP Stack nodes add the L1 data fee. */
  l1Fee?: string | null;
  logs: { address: string; topics: string[]; data: string }[];
};

/** `eth_getTransactionByHash`'s answer, as much of it as the effects need. */
export type RawTransaction = { value: string; input: string };

const MAX_HEX_CHARS = 2 + EFFECTS_BOUNDS.dataBytes * 2;

function quantity(hex: string | null | undefined): bigint {
  return hex ? BigInt(hex) : 0n;
}

/** ADR-0063: a receipt and its transaction as stored, cut to `EFFECTS_BOUNDS`. Pure. */
export function baseEffectsFrom(receipt: RawReceipt, transaction: RawTransaction): BaseEffects {
  let truncated = receipt.logs.length > EFFECTS_BOUNDS.entries;
  const cut = (hex: string) => {
    if (hex.length <= MAX_HEX_CHARS) return hex;
    truncated = true;
    return hex.slice(0, MAX_HEX_CHARS);
  };
  const gasUsed = quantity(receipt.gasUsed);
  const effectiveGasPrice = quantity(receipt.effectiveGasPrice);
  const l1Fee = quantity(receipt.l1Fee);
  const logs = receipt.logs.slice(0, EFFECTS_BOUNDS.entries).map((log) => ({
    address: log.address,
    topics: log.topics,
    data: cut(log.data),
  }));
  return {
    chain: 'base',
    blockNumber: quantity(receipt.blockNumber).toString(),
    from: receipt.from,
    to: receipt.to,
    value: quantity(transaction.value).toString(),
    input: cut(transaction.input),
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    l1Fee: l1Fee.toString(),
    fee: (gasUsed * effectiveGasPrice + l1Fee).toString(),
    logs,
    truncated,
  };
}
