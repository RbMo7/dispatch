import type { Chain } from './chains';
import type { TokenKind } from './flagRules';

/** A row of `GET /v1/contracts` (ADR-0063). */
export interface KnownContract {
  id: string;
  chain: Chain;
  address: string;
  label: string;
  /** What its ABI or IDL explains: Base functions, or Solana instructions, as signatures. */
  functions: string[];
  /** Base events it explains. */
  events: string[];
  enabled: boolean;
  addedBy: TokenKind;
  addedAt: Date;
}

/** `POST /v1/contracts/preview`: what registering it would explain. */
export interface ContractPreview {
  chain: Chain;
  address: string;
  label: string;
  functions: string[];
  events: string[];
}

/** What the console sends to preview or register: the ABI or IDL as it was pasted. */
export interface ContractRequest {
  chain: Chain;
  address: string;
  label: string;
  definition: string;
}
