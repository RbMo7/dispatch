import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { UsageError } from './errors.js';

export type Chain = 'solana' | 'base';

/** One payment in the caller's own file. `amount` is in base units. */
export interface Payment {
  recipient: string;
  /** `native`, or a mint (Solana) / contract (Base). */
  asset: string;
  amount: bigint;
  /** 1-based position among the payments in the file, for messages. */
  line: number;
}

export const NATIVE = 'native';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return new PublicKey(value).toBytes().length === 32;
  } catch {
    return false;
  }
}

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

/** Canonical form used for comparison: EVM addresses lower-cased, Solana as is. */
export function normalizeAddress(chain: Chain, value: string): string {
  return chain === 'base' ? value.toLowerCase() : value;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ''));
  const header = nonEmpty.shift();
  if (!header) throw new UsageError('payment file is empty');
  const names = header.map((h) => h.trim().toLowerCase());
  for (const required of ['recipient', 'asset', 'amount']) {
    if (!names.includes(required)) {
      throw new UsageError(
        `CSV payment file needs a header row with the columns recipient,asset,amount (missing "${required}")`,
      );
    }
  }
  return nonEmpty.map((r, i) => {
    if (r.length > names.length) {
      throw new UsageError(`payment ${i + 1}: more fields than header columns`);
    }
    const rec: Record<string, string> = {};
    names.forEach((n, idx) => {
      rec[n] = (r[idx] ?? '').trim();
    });
    return rec;
  });
}

function parseJson(text: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`payment file is not valid JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        Array.isArray((value as { payments?: unknown }).payments)
      ? (value as { payments: unknown[] }).payments
      : null;
  if (!list)
    throw new UsageError(
      'JSON payment file must be an array, or an object with a "payments" array',
    );
  return list.map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p))
      throw new UsageError(`payment ${i + 1}: not an object`);
    return p as Record<string, unknown>;
  });
}

function toAmount(raw: unknown, n: number): bigint {
  let text: string;
  if (typeof raw === 'string') text = raw.trim();
  else if (typeof raw === 'number' && Number.isSafeInteger(raw)) text = String(raw);
  else
    throw new UsageError(
      `payment ${n}: amount must be a whole number of base units (use a string for large values)`,
    );
  if (!/^[0-9]+$/.test(text)) {
    throw new UsageError(
      `payment ${n}: amount "${text}" is not a whole number of base units (no decimals, no signs)`,
    );
  }
  const amount = BigInt(text);
  if (amount <= 0n) throw new UsageError(`payment ${n}: amount must be greater than zero`);
  return amount;
}

/** Parse and validate a payment file (CSV or JSON, chosen by extension, then by content). */
export function parsePayments(
  text: string,
  chain: Chain,
  format: 'csv' | 'json' | 'auto' = 'auto',
): Payment[] {
  const trimmed = text.trimStart();
  const kind =
    format === 'auto'
      ? trimmed.startsWith('[') || trimmed.startsWith('{')
        ? 'json'
        : 'csv'
      : format;
  const records: Record<string, unknown>[] = kind === 'json' ? parseJson(text) : parseCsv(text);
  if (records.length === 0) throw new UsageError('payment file has no payments');
  const isAddress = chain === 'solana' ? isSolanaAddress : isEvmAddress;
  return records.map((rec, i) => {
    const n = i + 1;
    const recipient = typeof rec.recipient === 'string' ? rec.recipient.trim() : '';
    const assetRaw = typeof rec.asset === 'string' ? rec.asset.trim() : '';
    if (!isAddress(recipient))
      throw new UsageError(
        `payment ${n}: recipient "${recipient}" is not a valid ${chain} address`,
      );
    if (!assetRaw)
      throw new UsageError(
        `payment ${n}: asset is empty (use "native" or a ${chain === 'solana' ? 'mint' : 'contract'} address)`,
      );
    const asset = assetRaw.toLowerCase() === NATIVE ? NATIVE : assetRaw;
    if (asset !== NATIVE && !isAddress(asset))
      throw new UsageError(
        `payment ${n}: asset "${assetRaw}" is neither "native" nor a valid ${chain} address`,
      );
    return {
      recipient: normalizeAddress(chain, recipient),
      asset: asset === NATIVE ? NATIVE : normalizeAddress(chain, asset),
      amount: toAmount(rec.amount, n),
      line: n,
    };
  });
}

export function readPaymentsFile(path: string, chain: Chain): Payment[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read payment file ${path}: ${(e as Error).message}`);
  }
  const lower = path.toLowerCase();
  const format = lower.endsWith('.json') ? 'json' : lower.endsWith('.csv') ? 'csv' : 'auto';
  return parsePayments(text, chain, format);
}
