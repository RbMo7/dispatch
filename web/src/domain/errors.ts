import type { Money } from './assets';
import { type Chain, CHAINS } from './chains';
import type { Item, SenderRef } from './dispatch';
import type { Text } from './flow';

/** The parts of an error's `chainDetail` the console explains, each read only when the engine sent it. */
export interface ErrorDetail {
  asset?: string;
  /** `INSUFFICIENT_FUNDS`: the shortfall, in the asset's smallest unit. */
  short?: string;
  /** `INSUFFICIENT_FUNDS` on a Multisig Sender: which balance is short, and its address. */
  holder?: string;
  address?: string;
  /** `APPROVAL_TIMEOUT`. */
  deadlineAt?: Date;
  /** `APPROVAL_REJECTED`: rejected, cancelled or stale. */
  status?: string;
  /** `CHAIN_REJECTED` from a Base revert: the revert reason. */
  reason?: string;
  httpStatus?: number;
}

/** An error as the console reads it: an item's, a Dispatch's, or a refused request's. `code` is null for a plain error. */
export interface ReadError {
  code: string | null;
  message: string;
  detail?: ErrorDetail;
}

/** Where an error happened: what the catalogue needs beyond the error itself. */
export interface ErrorContext {
  chain: Chain | null;
  sender?: SenderRef | null;
  /** An asset's decimals, when the console knows them, so a shortfall reads as an amount. */
  decimals?: (asset: string) => number | undefined;
}

/** A Dispatch's errors happened on its chain, for its Sender, in amounts whose decimals its own items carry. */
export function errorContext(
  chain: Chain,
  sender: SenderRef | null,
  items: readonly Item[],
): ErrorContext {
  return {
    chain,
    sender,
    decimals: (asset) => {
      const like = items.find((i) => i.type === 'payment' && i.asset === asset && i.amount);
      return like?.type === 'payment' ? like.amount?.decimals : undefined;
    },
  };
}

export interface Fix {
  label: string;
  href: string;
}

export interface Explanation {
  title: string;
  /** One line for a table row. */
  line: string;
  /** What happened, from the error's `chainDetail`. Amounts stay `Money` so hidden balances mask them. */
  text: Text;
  /** What to do about it. */
  next: string;
  fix: Fix | null;
}

interface Entry {
  title: string;
  line?: (error: ReadError, ctx: ErrorContext) => string | null;
  text?: Text | ((error: ReadError, ctx: ErrorContext) => Text);
  next: string | ((error: ReadError, ctx: ErrorContext) => string);
  fix?: (error: ReadError, ctx: ErrorContext) => Fix | null;
}

const short = (address: string) =>
  address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
const chainName = (ctx: ErrorContext) => (ctx.chain ? CHAINS[ctx.chain].label : 'this chain');
const sentence = (text: string) => {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};
const said = (error: ReadError) => sentence(error.message);

const HOLDERS: Record<string, string> = {
  vault: 'its vault',
  memberKey: 'its member key',
  safe: 'its Safe',
  executor: 'its executor key',
};

const deadline = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const SENDERS: Fix = { label: 'Open Senders & Keys', href: '/console/senders' };
const SETUP: Fix = { label: 'Open Setup', href: '/console/setup' };
const docs = (label: string, page: string): Fix => ({ label, href: `/docs/${page}` });

/** A symbol goes in as `symbol`; anything shaped like a mint or contract goes in as `address`. */
function addAssetLink(asset: string, chain: Chain | null): Fix {
  const params = new URLSearchParams();
  if (chain) params.set('chain', chain);
  params.set(
    /^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset) ? 'address' : 'symbol',
    asset,
  );
  return { label: 'Add it under Assets', href: `/console/assets?${params}` };
}

/**
 * Every error code the engine documents (docs/openapi.yaml's `Error` and
 * `RequestError` enums), to what a person needs: a title, what happened, and
 * what to do. A test fails when the API documents a code this table lacks.
 */
export const CATALOGUE = {
  INSUFFICIENT_FUNDS: {
    title: 'Not enough funds',
    text: ({ detail }, ctx) => {
      const who = ctx.sender?.name ?? 'The Sender';
      const holder = detail?.holder ? HOLDERS[detail.holder] : undefined;
      const payer = holder ? `${who}, ${holder},` : who;
      const decimals = detail?.asset ? ctx.decimals?.(detail.asset) : undefined;
      const address = detail?.address ?? ctx.sender?.address;
      const fund = address ? ` Fund ${short(address)}.` : '';
      if (detail?.asset && detail.short && decimals !== undefined) {
        const amount: Money = { asset: detail.asset, raw: detail.short, decimals };
        return [`${payer} is short `, amount, `.${fund}`];
      }
      return `${payer} cannot cover it${detail?.asset ? ` in ${detail.asset}` : ''}.${fund}`;
    },
    next: 'Fund it, then send the failed payments again in a new Dispatch with a new key.',
    fix: () => SENDERS,
  },
  INVALID_RECIPIENT: {
    title: 'Not a usable address',
    next: 'Fix the address and send it again.',
  },
  UNKNOWN_ASSET: {
    title: 'Unknown asset',
    line: ({ detail }, ctx) =>
      detail?.asset ? `${detail.asset} is not a known asset on ${chainName(ctx)}` : null,
    text: ({ detail }, ctx) =>
      detail?.asset
        ? `${detail.asset} is not a known asset on ${chainName(ctx)}.`
        : `The payment names an asset that is not known on ${chainName(ctx)}.`,
    next: 'Add it under Assets, then send again.',
    fix: ({ detail }, ctx) => (detail?.asset ? addAssetLink(detail.asset, ctx.chain) : null),
  },
  CHAIN_REJECTED: {
    title: 'Not valid on the chain',
    line: ({ detail }) => (detail?.reason ? `Reverted: ${detail.reason}` : null),
    text: (error) =>
      error.detail?.reason
        ? `The transaction reverted on chain with the reason "${error.detail.reason}".`
        : said(error),
    next: 'Fix the cause and send it in a new Dispatch. Sending the same thing again fails the same way.',
  },
  RPC_UNAVAILABLE: {
    title: 'Chain RPC unavailable',
    text: ({ detail }, ctx) =>
      `The ${chainName(ctx)} RPC could not be reached or did not answer${detail?.httpStatus ? ` (HTTP ${detail.httpStatus})` : ''}.`,
    next: 'Send it again later with a new key. Use your own RPC provider for real traffic.',
    fix: () => SETUP,
  },
  SIGNER_UNREACHABLE: {
    title: 'Signer unreachable',
    text: 'The worker could not reach the Signer, or got back an unusable signature. Nothing was sent.',
    next: 'Check the Signer, then send again with a new key.',
    fix: () => SETUP,
  },
  SIGNER_REFUSED: {
    title: 'Refused by the Signer',
    line: ({ message }) => `Signer refused: ${message.replace(/^signer refused:\s*/i, '')}`,
    text: ({ message }) =>
      `The Signer's policy refused this transaction: ${message.replace(/^signer refused:\s*/i, '')}.`,
    next: "Fix the request, or change the Signer's policy for this key.",
    fix: () => docs('Signer policy', 'self-hosting/signer'),
  },
  CHAIN_NOT_ENABLED: {
    title: 'Chain not enabled',
    text: (_, ctx) => `This engine does not have ${chainName(ctx)} in ENABLED_CHAINS.`,
    next: 'Use an enabled chain, or add it to ENABLED_CHAINS and restart the engine.',
    fix: () => SENDERS,
  },
  UNKNOWN_SENDER: {
    title: 'Unknown Sender',
    next: 'Use a Sender name that Senders & Keys lists.',
    fix: () => SENDERS,
  },
  SENDER_REQUIRED: {
    title: 'No Sender named',
    text: (_, ctx) => `${chainName(ctx)} has no default Sender, so a Dispatch must name one.`,
    next: 'Name the Sender with `sender`.',
    fix: () => SENDERS,
  },
  NONCE_ALREADY_USED: {
    title: 'Nonce already used',
    text: 'Something else sent from this Sender and used the nonce this transaction needed.',
    next: 'Make sure only the engine sends from the Sender, then send it again.',
  },
  APPROVAL_REJECTED: {
    title: 'Rejected by Approvers',
    text: ({ detail }) =>
      detail?.status === 'stale'
        ? 'The Proposal went stale: the multisig moved past it before it was executed.'
        : detail?.status === 'cancelled'
          ? 'The Approvers cancelled the Proposal.'
          : 'The Approvers rejected the Proposal. Nothing was paid.',
    next: 'Send it again only if the Approvers want it.',
  },
  APPROVAL_TIMEOUT: {
    title: 'No decision in time',
    text: ({ detail }) =>
      detail?.deadlineAt
        ? `Nobody decided on the Proposal by its deadline, ${deadline.format(detail.deadlineAt)}.`
        : 'Nobody decided on the Proposal by its deadline.',
    next: 'Check the multisig before sending it again: someone may still approve and execute it.',
  },
  ALREADY_CLAIMED: {
    title: 'Already claimed',
    text: 'The worker already claimed this Dispatch, so it can no longer be cancelled.',
    next: 'Nothing. The Dispatch is being sent.',
  },
  NOT_HELD: {
    title: 'Not held',
    text: 'This Dispatch is not held, so there is nothing to release.',
    next: 'Nothing. Read the Dispatch to see where it is.',
  },
  RULE_DELETED: {
    title: 'Rule deleted',
    text: 'This Flag Rule was deleted, so it can no longer be edited.',
    next: 'Create a new rule.',
  },
  NOT_A_TOKEN: {
    title: 'Not a token',
    next: 'Check the address and the chain.',
  },
  NOT_PAYABLE: {
    title: 'Token cannot be paid out',
    next: 'Pay in another token.',
  },
  SYMBOL_REQUIRED: {
    title: 'Symbol required',
    text: 'The token publishes no usable symbol.',
    next: 'Give it a symbol.',
  },
  SYMBOL_TAKEN: {
    title: 'Symbol taken',
    next: 'Use another symbol, or disable the other asset first.',
  },
  ASSET_EXISTS: {
    title: 'Already a known asset',
    next: 'Enable it under Assets instead.',
  },
  CONFIG_ASSET: {
    title: 'Set in the configuration',
    text: 'This asset comes from the engine configuration, so the console cannot change it.',
    next: 'Change the *_KNOWN_TOKENS setting and restart the engine.',
  },
  FST_ERR_VALIDATION: {
    title: 'Request does not match the API',
    next: 'Fix the field the message names, then send it again.',
    fix: () => docs('API reference', 'rest/dispatches'),
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    title: 'Body is not JSON',
    text: 'The request body could not be read as JSON.',
    next: 'Send a JSON body with Content-Type: application/json.',
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    title: 'Body too large',
    text: 'The request body is over 1 MiB.',
    next: 'Split the run into several Dispatches.',
  },
} satisfies Record<string, Entry>;

export type ErrorCode = keyof typeof CATALOGUE;

const PLAIN: Entry = {
  title: 'Invalid request',
  next: 'Fix the request and send it again.',
  fix: () => docs('API reference', 'rest/dispatches'),
};

/** Pure: an error, read with where it happened, as the console shows it. */
export function explainError(error: ReadError, ctx: ErrorContext): Explanation {
  const entry: Entry =
    error.code === null
      ? PLAIN
      : error.code in CATALOGUE
        ? CATALOGUE[error.code as ErrorCode]
        : { title: error.code, next: 'Read the message, fix the cause and send it again.' };
  const text =
    typeof entry.text === 'function' ? entry.text(error, ctx) : (entry.text ?? said(error));
  return {
    title: entry.title,
    line: entry.line?.(error, ctx) ?? entry.title,
    text,
    next: typeof entry.next === 'function' ? entry.next(error, ctx) : entry.next,
    fix: entry.fix?.(error, ctx) ?? null,
  };
}
