import { formatUnits } from 'viem';

import type { ContractAt } from '../contract-registry/contract-registry.js';
import type { Chain } from '../domain/chain.js';
import type { KnownAsset } from '../domain/known-asset.js';

/**
 * ADR-0063: what an item read says about a call and about what its
 * transaction changed. Built when it is read, by pure decoders over the
 * stored effects and the item's own call data, so an ABI or IDL registered
 * later explains earlier transactions too. Never from a third-party service.
 */

/** A Known Asset by what identifies it, with what to call it. */
export type AssetRef = { address: string; symbol: string; name: string; decimals: number };

/** An amount in the asset's smallest unit; `asset` and `formatted` when the asset is a Known Asset. */
export type AmountView = { amount: string; asset?: AssetRef; formatted?: string };

/** `null` is an Anchor option left empty. */
export type ArgValue = string | boolean | null | ArgValue[] | { [name: string]: ArgValue };

/** One named, typed argument. An amount of a Known Asset also carries the asset and the amount in its units. */
export type ArgView = {
  name: string;
  type: string;
  value: ArgValue;
  asset?: AssetRef;
  formatted?: string;
};

export type CallView = {
  /** The contract (Base) or program (Solana) called. */
  target: string;
  /** The target's label in the contract registry, when it is registered. */
  label?: string;
  /** True when a decoder named the function, or the call carries no data to decode. */
  decoded: boolean;
  /** Which decoder: a built-in (`erc20`, `erc721`, `erc1155`, `weth`, `multicall3`, `system`, `spl-token`, `token-2022`, `associated-token-account`, `memo`, `compute-budget`), or the registered `abi` or `idl`. */
  decoder?: string;
  function?: string;
  args?: ArgView[];
  /** Base: the 4-byte selector. Solana: the instruction discriminator, hex. */
  selector?: string;
  /** The raw data, only when it was not decoded: hex on Base, base64 on Solana. */
  data?: string;
  /** Base: native value sent with the call, when not zero. */
  value?: AmountView;
  /** Multicall3: each call it makes, decoded the same way. */
  calls?: InnerCallView[];
};

export type InnerCallView = CallView & { allowFailure: boolean };

export type TransferStandard = 'native' | 'erc20' | 'erc721' | 'erc1155' | 'spl' | 'token-2022';

/** Value that moved. `from` null is a mint, `to` null a burn. On Solana `from` and `to` are the token accounts' owners when known. */
export type TransferView = AmountView & {
  standard: TransferStandard;
  /** The contract or mint; `native` for the chain's own coin. */
  token: string;
  from: string | null;
  to: string | null;
  /** ERC-721 and ERC-1155. */
  tokenId?: string;
};

/** A decoded receipt log (Base) or instruction (Solana, inner ones included). */
export type EventView = {
  kind: 'log' | 'instruction';
  /** The contract that emitted the log, or the program that ran. */
  source: string;
  /** The source's label in the contract registry. */
  label?: string;
  decoder: string;
  name: string;
  args: ArgView[];
};

export type EffectsView = {
  transfers: TransferView[];
  /** Base: native value the transaction itself sent, when not zero. */
  value?: AmountView;
  fee: AmountView & { payer: string };
  events: EventView[];
  /** Logs or instructions no decoder knows. */
  undecodedEvents: number;
  /** Where the undecoded ones came from, most first, labelled when the source is registered. */
  undecodedEventSources: { source: string; label?: string; count: number }[];
  /** Some of what the transaction did was cut from storage (the bounds in `EFFECTS_BOUNDS`). */
  truncated: boolean;
};

/** Any Known Asset at a mint or contract, `native` for the chain's coin; undefined when none. */
export type AssetAt = (chain: Chain, address: string) => KnownAsset | undefined;

/** What decoding reads besides the call and its effects: the asset registry and the contract registry. */
export type Known = { assetAt: AssetAt; contractAt: ContractAt };

/** The registry's label for `address`, as a field to spread into a view. */
export function labelOf(known: Known, chain: Chain, address: string): { label?: string } {
  const label = known.contractAt(chain, address)?.label;
  return label === undefined ? {} : { label };
}

export function assetRef(asset: KnownAsset): AssetRef {
  return {
    address: asset.address,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
  };
}

/** An amount of whatever is at `address`, formatted when it is a Known Asset. */
export function amountOf(
  assetAt: AssetAt,
  chain: Chain,
  address: string | undefined,
  amount: bigint | string,
): AmountView {
  const known = address === undefined ? undefined : assetAt(chain, address);
  const raw = amount.toString();
  if (!known) return { amount: raw };
  return {
    amount: raw,
    asset: assetRef(known),
    formatted: formatUnits(BigInt(raw), known.decimals),
  };
}

/** Counts each source's undecoded entries, most first. */
export function undecodedSources(
  known: Known,
  chain: Chain,
  sources: string[],
): EffectsView['undecodedEventSources'] {
  const counts = new Map<string, number>();
  for (const source of sources) counts.set(source, (counts.get(source) ?? 0) + 1);
  return [...counts]
    .map(([source, count]) => ({ source, ...labelOf(known, chain, source), count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}
