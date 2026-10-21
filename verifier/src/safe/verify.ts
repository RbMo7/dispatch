import { compare, type Item } from '../compare.js';
import { RpcError, UsageError } from '../errors.js';
import { NATIVE, type Payment } from '../payments.js';
import type { Report } from '../report.js';
import {
  MULTISEND_CALL_ONLY,
  ZERO_ADDRESS,
  bundleTx,
  decodeMultiSend,
  paymentToItem,
  safeTxHash,
  type SafeTx,
} from './hash.js';
import { readSafe, type EvmRpc } from './rpc.js';
import type { ServiceClient, ServiceTx } from './service.js';
import type { Hex } from 'viem';

export interface SafeInput {
  safe: string;
  payments: Payment[];
  bundleSize: number;
  rpc: EvmRpc;
  /** The hash the owners see in the Safe app. Optional only when `service` can look it up from the nonce. */
  safeTxHash?: string | undefined;
  nonce?: bigint | undefined;
  service?: ServiceClient | undefined;
}

const CHAIN_NAMES: Record<number, string> = { 8453: 'Base', 84532: 'Base Sepolia' };

interface Candidate {
  chunk: number;
  firstLine: number;
  lastLine: number;
  payments: Payment[];
  multiSend: string;
  hash: string;
}

function chunks(payments: Payment[], size: number): Payment[][] {
  const out: Payment[][] = [];
  for (let i = 0; i < payments.length; i += size) out.push(payments.slice(i, i + size));
  return out;
}

function candidates(
  safe: string,
  chainId: number,
  nonce: bigint,
  version: string,
  payments: Payment[],
  size: number,
): Candidate[] {
  const addresses = MULTISEND_CALL_ONLY[version];
  if (!addresses)
    throw new RpcError(`Safe version ${version} is not supported (only 1.3.0 and 1.4.1)`);
  const out: Candidate[] = [];
  chunks(payments, size).forEach((c, i) => {
    for (const multiSend of addresses) {
      out.push({
        chunk: i + 1,
        firstLine: (c[0] as Payment).line,
        lastLine: (c[c.length - 1] as Payment).line,
        payments: c,
        multiSend,
        hash: safeTxHash(safe, chainId, bundleTx(multiSend, c.map(paymentToItem), nonce)),
      });
    }
  });
  return out;
}

const toItem = (p: Payment): Item => ({
  recipient: p.recipient,
  asset: p.asset,
  amount: p.amount,
  position: p.line,
});

function serviceToSafeTx(s: ServiceTx): SafeTx {
  return {
    to: s.to,
    value: BigInt(s.value),
    data: (s.data ?? '0x') as Hex,
    operation: s.operation === 1 ? 1 : 0,
    safeTxGas: BigInt(s.safeTxGas),
    baseGas: BigInt(s.baseGas),
    gasPrice: BigInt(s.gasPrice),
    gasToken: s.gasToken ?? ZERO_ADDRESS,
    refundReceiver: s.refundReceiver ?? ZERO_ADDRESS,
    nonce: BigInt(s.nonce),
  };
}

export async function verifySafe(input: SafeInput): Promise<Report> {
  const safe = input.safe;
  const notes: string[] = [];
  const problems: string[] = [];

  const chainId = await input.rpc.chainId();
  const state = await readSafe(input.rpc, safe);
  if (!MULTISEND_CALL_ONLY[state.version]) {
    throw new RpcError(
      `Safe ${safe} is version ${state.version}; only 1.3.0 and 1.4.1 are supported`,
    );
  }

  // --- which proposal is this?
  let hash = input.safeTxHash?.toLowerCase();
  let svc: ServiceTx | null = null;
  let nonce = input.nonce;
  if (!hash) {
    if (!input.service || nonce === undefined) {
      throw new UsageError(
        'give --safe-tx-hash, or --nonce together with --tx-service-url so the proposal can be looked up',
      );
    }
    const found = await input.service.listByNonce(safe, nonce);
    if (found.length === 0)
      throw new RpcError(
        `the Transaction Service has no proposal for Safe ${safe} at nonce ${nonce}`,
      );
    if (found.length > 1) {
      throw new UsageError(
        `the Transaction Service lists ${found.length} proposals at nonce ${nonce}; pass the one you are voting on with --safe-tx-hash:\n${found.map((f) => `  ${f.safeTxHash}`).join('\n')}`,
      );
    }
    svc = found[0] as ServiceTx;
    hash = svc.safeTxHash.toLowerCase();
  } else if (input.service) {
    svc = await input.service.getTx(hash);
    if (!svc) notes.push('the Transaction Service does not know this safeTxHash');
  }

  // --- cross-check the service's copy of the transaction: it must re-hash to the hash the owners see
  let svcTx: SafeTx | null = null;
  if (svc) {
    svcTx = serviceToSafeTx(svc);
    if (svc.safe.toLowerCase() !== safe.toLowerCase())
      problems.push(
        `the Transaction Service says this proposal belongs to Safe ${svc.safe}, not ${safe}`,
      );
    const rehash = safeTxHash(safe, chainId, svcTx);
    if (rehash.toLowerCase() !== hash) {
      problems.push(
        `the Transaction Service's copy of the transaction hashes to ${rehash}, not to ${hash}: the service data cannot be trusted`,
      );
      svcTx = null;
    }
    if (nonce !== undefined && BigInt(svc.nonce) !== nonce)
      problems.push(
        `the Transaction Service says the proposal is at nonce ${svc.nonce}, not ${nonce}`,
      );
    nonce ??= BigInt(svc.nonce);
  }
  if (nonce === undefined) {
    nonce = state.nonce;
    notes.push(
      `no --nonce given: assumed the Safe's current nonce ${nonce} (the next transaction to execute)`,
    );
  }

  // --- recompute every chunk of the file at this nonce
  const cands = candidates(safe, chainId, nonce, state.version, input.payments, input.bundleSize);
  const match = cands.find((c) => c.hash.toLowerCase() === hash);
  const fileItems = input.payments.map(toItem);

  const facts: [string, string][] = [
    ['Chain', `${CHAIN_NAMES[chainId] ?? 'unknown chain'} (chain id ${chainId})`],
    ['Safe', safe],
    ['Safe version', state.version],
    ['Owners / threshold', `${state.owners.length} owners, ${state.threshold} needed`],
    ['Safe nonce now', String(state.nonce)],
    ['Proposal nonce', String(nonce)],
    ['safeTxHash', hash],
  ];

  // --- status
  if (svc) {
    const sigs = svc.confirmations?.length ?? 0;
    const status = svc.isExecuted
      ? svc.isSuccessful === false
        ? 'Executed, but the transaction failed'
        : 'Executed'
      : 'Awaiting confirmations / execution';
    facts.push([
      'Status',
      `${status} (service: ${sigs} of ${svc.confirmationsRequired ?? state.threshold} confirmations)`,
    ]);
  } else if (nonce < state.nonce) {
    facts.push([
      'Status',
      `Safe nonce is already ${state.nonce}: a transaction at nonce ${nonce} was executed or replaced, so this proposal can no longer run (use --tx-service-url to see which)`,
    ]);
  } else if (nonce === state.nonce) {
    facts.push([
      'Status',
      'Not executed; it is next in the Safe queue (confirmations are not read without --tx-service-url)',
    ]);
  } else {
    facts.push(['Status', `Not executed; queued behind ${nonce - state.nonce} earlier nonce(s)`]);
  }

  if (match) {
    facts.push(['MultiSend', `${match.multiSend} (MultiSendCallOnly for Safe ${state.version})`]);
    if (
      svcTx &&
      (svcTx.operation !== 1 || svcTx.to.toLowerCase() !== match.multiSend.toLowerCase())
    ) {
      problems.push('the Transaction Service copy is not a delegatecall to MultiSendCallOnly');
    }
    const items = match.payments.map(toItem);
    const comparison = compare(items, items);
    return {
      verdict: problems.length === 0 ? 'MATCH' : 'MISMATCH',
      facts,
      problems,
      notes: [
        ...notes,
        'the hash commits to the whole bundle in this order: the same payments in a different order would not match',
        ...(match.payments.some((p) => p.asset !== NATIVE)
          ? ['ERC-20 items are `transfer(recipient, amount)` calls from the Safe']
          : []),
      ],
      comparison,
      proposalItems: items,
      fileItems,
      chunk: {
        index: match.chunk,
        of: Math.ceil(input.payments.length / input.bundleSize),
        firstLine: match.firstLine,
        lastLine: match.lastLine,
      },
    };
  }

  // --- no chunk matches: say so, and show what we can
  const nChunks = Math.ceil(input.payments.length / input.bundleSize);
  problems.push(
    `the safeTxHash ${hash} is not the hash of any of the ${nChunks} chunk(s) of your file (bundle size ${input.bundleSize}) at nonce ${nonce} on chain ${chainId}`,
  );

  // Does it match at a different nonce? (a very common slip)
  const upTo = Number(state.nonce > nonce ? state.nonce : nonce) + 25;
  for (let n = 0; n <= upTo && n <= 500; n++) {
    if (BigInt(n) === nonce) continue;
    const other = candidates(
      safe,
      chainId,
      BigInt(n),
      state.version,
      input.payments,
      input.bundleSize,
    ).find((c) => c.hash.toLowerCase() === hash);
    if (other) {
      problems.push(
        `...but it IS chunk ${other.chunk} (file payments ${other.firstLine} to ${other.lastLine}) at nonce ${n}: check the nonce`,
      );
      break;
    }
  }

  let comparison;
  let proposalItems: Item[] | undefined;
  if (svcTx) {
    const decoded = svcTx.operation === 1 ? decodeMultiSend(svcTx.data) : null;
    if (!decoded) {
      problems.push(
        'the Transaction Service copy of the proposal is not a MultiSend bundle of payments (unrecognized transaction)',
      );
    } else {
      const items: Item[] = [];
      decoded.forEach((d, i) => {
        if (d.kind === 'native')
          items.push({ recipient: d.recipient, asset: NATIVE, amount: d.amount, position: i + 1 });
        else if (d.kind === 'erc20')
          items.push({ recipient: d.recipient, asset: d.token, amount: d.amount, position: i + 1 });
        else problems.push(`item ${i + 1}: unrecognized instruction (${d.reason})`);
      });
      proposalItems = items;
      // closest chunk = the one the proposal agrees with most
      const mine = cands.filter(
        (c) => c.multiSend === (MULTISEND_CALL_ONLY[state.version] as string[])[0],
      );
      let best = mine[0] as Candidate;
      let bestScore = -1;
      for (const c of mine) {
        const score = compare(items, c.payments.map(toItem)).matched.length;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      comparison = compare(items, best.payments.map(toItem));
      notes.push(
        `differences are shown against the closest chunk: chunk ${best.chunk} (file payments ${best.firstLine} to ${best.lastLine})`,
      );
      if (comparison.uncovered.length > 0) {
        problems.push(
          `${comparison.uncovered.length} payment(s) of that chunk are missing from the proposal (file lines ${comparison.uncovered.map((u) => u.position).join(', ')})`,
        );
      }
      if (comparison.mismatches.length > 0)
        problems.push(
          `${comparison.mismatches.length} payment(s) in the proposal differ from your file`,
        );
    }
  } else {
    notes.push(
      'the hash alone cannot show what differs; pass --tx-service-url (the Safe Transaction Service) to decode the proposal and diff it line by line',
    );
    notes.push(
      `computed chunk hashes at nonce ${nonce}: ${cands
        .filter((c) => c.multiSend === (MULTISEND_CALL_ONLY[state.version] as string[])[0])
        .map((c) => `#${c.chunk} ${c.hash}`)
        .join(' ')}`,
    );
  }

  return {
    verdict: 'MISMATCH',
    facts,
    problems,
    notes,
    ...(comparison ? { comparison } : {}),
    ...(proposalItems ? { proposalItems } : {}),
    fileItems,
  };
}
