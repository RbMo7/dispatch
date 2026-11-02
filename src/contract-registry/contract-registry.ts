import type { Chain } from '../domain/chain.js';
import type { KnownContract, NewKnownContract } from '../domain/known-contract.js';
import { err, ok, type Result } from '../domain/result.js';
import { describeAbi, parseAbi, type ParsedAbi } from './abi.js';
import { idlSignature, parseIdl, type ParsedIdl } from './idl.js';

type DecoderByChain = { base: { abi: ParsedAbi }; solana: { idl: ParsedIdl } };

/** A registered contract as the decoders use it: its label and its parsed ABI or IDL. */
export type RegisteredContract<C extends Chain = Chain> = {
  [K in C]: { chain: K; id: string; address: string; label: string } & DecoderByChain[K];
}[C];

/** The enabled registered contract at an address, if any. */
export type ContractAt = <C extends Chain>(
  chain: C,
  address: string,
) => RegisteredContract<C> | undefined;

export const NO_CONTRACTS: ContractAt = () => undefined;

/** What a contract's definition explains: Base functions and events, or Solana instructions. */
export type ContractSummary = { functions: string[]; events: string[] };

/**
 * Reads the ABI or IDL a contract was given: the decoder, and the definition
 * to store (an ABI unwrapped from a compiler artifact). The error names what
 * is wrong and where.
 */
export function parseDefinition<C extends Chain>(
  contract: NewKnownContract<C>,
): Result<{ decoder: DecoderByChain[C]; stored: unknown }, string> {
  if (contract.chain === 'base') {
    const parsed = parseAbi((contract as NewKnownContract<'base'>).abi);
    return parsed.ok
      ? ok({ decoder: { abi: parsed.value.parsed }, stored: parsed.value.abi } as never)
      : parsed;
  }
  const idl = (contract as NewKnownContract<'solana'>).idl;
  const parsed = parseIdl(idl);
  if (!parsed.ok) return parsed;
  if (parsed.value.address !== null && parsed.value.address !== contract.address) {
    return err(
      `idl.address: the IDL is for the program ${parsed.value.address}, not ${contract.address}`,
    );
  }
  return ok({ decoder: { idl: parsed.value }, stored: idl } as never);
}

export function summarize(decoder: DecoderByChain[Chain]): ContractSummary {
  return 'abi' in decoder
    ? describeAbi(decoder.abi)
    : { functions: decoder.idl.instructions.map(idlSignature), events: [] };
}

/** Base addresses are hex, so case never tells two apart; Solana's base58 is case-sensitive. */
const key = (chain: Chain, address: string) =>
  `${chain}:${chain === 'base' ? address.toLowerCase() : address}`;

export type ContractEntry = {
  contract: KnownContract;
  /** Null when a stored definition no longer parses: listed, but it explains nothing. */
  summary: ContractSummary | null;
};

/**
 * ADR-0063: the contracts operators registered, as the API decodes calls and
 * events with them. Loaded from `known_contracts` and refreshed when it changes.
 */
export class ContractRegistry {
  private entries: ContractEntry[] = [];
  private enabled = new Map<string, RegisteredContract>();
  /** Refreshes run one after another, so an older read never lands after a newer one. */
  private refreshing: Promise<void> = Promise.resolve();

  constructor(private readonly load: () => Promise<readonly KnownContract[]>) {}

  static of(rows: readonly KnownContract[]): ContractRegistry {
    const registry = new ContractRegistry(() => Promise.resolve(rows));
    registry.index(rows);
    return registry;
  }

  private index(rows: readonly KnownContract[]): void {
    const enabled = new Map<string, RegisteredContract>();
    const entries = [...rows]
      .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
      .map((contract) => {
        const parsed = parseDefinition(contract);
        if (parsed.ok && contract.enabled) {
          enabled.set(key(contract.chain, contract.address), {
            chain: contract.chain,
            id: contract.id,
            address: contract.address,
            label: contract.label,
            ...parsed.value.decoder,
          } as RegisteredContract);
        }
        return { contract, summary: parsed.ok ? summarize(parsed.value.decoder) : null };
      });
    this.entries = entries;
    this.enabled = enabled;
  }

  /** Reads every row again. Resolves once this read, and every one asked for before it, has landed. */
  refresh(): Promise<void> {
    this.refreshing = this.refreshing
      .catch(() => {})
      .then(async () => this.index(await this.load()));
    return this.refreshing;
  }

  /** Every row of `chain`, or of every chain, newest first. */
  list(chain?: Chain): ContractEntry[] {
    return chain ? this.entries.filter((e) => e.contract.chain === chain) : [...this.entries];
  }

  get(id: string): ContractEntry | undefined {
    return this.entries.find((e) => e.contract.id === id);
  }

  readonly at: ContractAt = (chain, address) => this.enabled.get(key(chain, address)) as never;
}
