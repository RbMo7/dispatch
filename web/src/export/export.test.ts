// @vitest-environment node
import { strFromU8, unzipSync } from 'fflate';
import { readSheet } from 'read-excel-file/universal';
import { describe, expect, it } from 'vitest';

import type { DispatchSummary, Item } from '../domain/dispatch';
import { dispatchColumns, ITEM_COLUMNS } from './columns';
import { toCsv } from './csv';
import { dispatchesFileName, itemsFileName } from './download';
import { toXlsx } from './xlsx';

const ITEMS: Item[] = [
  {
    index: 0,
    type: 'payment',
    recipient: '0x4c1e2f0a9b7d3e5c8a6f1b2d4e9c0a7f3b5d9a07',
    asset: 'USDC',
    amount: { raw: '1284500000', decimals: 6, asset: 'USDC' },
    status: 'confirmed',
    transactionHash: '0x3e9d4c71aa02f86b1d5e9c37b40e2f18c6a9d5b210e4f7a8c3d1b6e9f0a2c41',
    error: null,
    approval: null,
  },
  {
    index: 1,
    type: 'payment',
    recipient: '=HYPERLINK("http://evil.example","x")',
    asset: 'USDC',
    amount: { raw: '17256001', decimals: 6, asset: 'USDC' },
    status: 'failed',
    transactionHash: null,
    error: {
      code: 'INVALID_RECIPIENT',
      message: 'No code at the address, and the token says "no", refusing it',
    },
    approval: null,
  },
  {
    index: 2,
    type: 'call',
    target: '+cmd|calc',
    status: 'queued',
    transactionHash: null,
    error: { code: '@SUM', message: 'line one\nline two' },
    approval: null,
  },
  {
    index: 3,
    type: 'payment',
    recipient: '0x9a07b5d93f7a0c9e4d2b1f6a8c5e3d0a2f1e2c4c',
    asset: 'ETH',
    amount: { raw: '123456789012345678901234567', decimals: 18, asset: 'ETH' },
    status: 'confirmed',
    transactionHash: '0x19c2be07f4a1d3c58e2b9a60d71f3c4e8a5b2d07e6c1f94a3b8d2e70c5a1f9d0e',
    error: null,
    approval: null,
  },
];

const DISPATCHES: DispatchSummary[] = [
  {
    id: '7f3a91c2',
    mode: 'managed',
    chain: 'base',
    sender: { name: 'payouts', address: '0x8b21c4e09f7a3d56b1e2c8f0a4d97e3b6c5144fe' },
    status: 'broadcasting',
    createdAt: new Date('2026-10-31T14:02:11Z'),
    itemCount: 37,
    totals: [{ raw: '12480000000', decimals: 6, asset: 'USDC' }],
  },
  {
    id: '5ac83f1e',
    mode: 'relay',
    chain: 'solana',
    sender: null,
    status: 'failed',
    createdAt: new Date('2026-10-30T12:20:02Z'),
    itemCount: 1,
    totals: [{ raw: '81370000', decimals: 9, asset: 'SOL' }],
  },
];

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && input[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  return rows;
}

describe('CSV export', () => {
  const csv = toCsv(ITEM_COLUMNS, ITEMS);

  it('is UTF-8 with a BOM, a header row and CRLF line ends', () => {
    expect(csv.startsWith('﻿Index,Type,Recipient or target,')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('reads back to the same values, quotes and newlines included', () => {
    const rows = parseCsv(csv.slice(1));
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual([
      '0',
      'payment',
      ITEMS[0]!.type === 'payment' ? ITEMS[0]!.recipient : '',
      'USDC',
      '1284.500000',
      'Confirmed',
      ITEMS[0]!.transactionHash,
      '',
      '',
    ]);
    expect(rows[2]![8]).toBe('No code at the address, and the token says "no", refusing it');
    expect(rows[3]![8]).toBe('line one\nline two');
  });

  it('writes every amount exactly at full precision and leaves a missing one empty', () => {
    const rows = parseCsv(csv.slice(1));
    expect(rows[2]![4]).toBe('17.256001');
    expect(rows[3]![4]).toBe('');
    expect(rows[4]![4]).toBe('123456789.012345678901234567');
  });

  it('defuses cells a spreadsheet would run as formulas', () => {
    const rows = parseCsv(csv.slice(1));
    expect(rows[2]![2]).toBe(`'=HYPERLINK("http://evil.example","x")`);
    expect(rows[3]![2]).toBe(`'+cmd|calc`);
    expect(rows[3]![7]).toBe(`'@SUM`);
  });

  it('writes dates as ISO 8601 and a column per asset total for Dispatches', () => {
    const rows = parseCsv(toCsv(dispatchColumns(['USDC', 'SOL']), DISPATCHES).slice(1));
    expect(rows[0]).toEqual([
      'Id',
      'Mode',
      'Chain',
      'Status',
      'Created',
      'Items',
      'USDC total',
      'SOL total',
    ]);
    expect(rows[1]).toEqual([
      '7f3a91c2',
      'managed',
      'Base',
      'Broadcasting',
      '2026-10-31T14:02:11.000Z',
      '37',
      '12480.000000',
      '',
    ]);
    expect(rows[2]).toEqual([
      '5ac83f1e',
      'relay',
      'Solana',
      'Failed',
      '2026-10-30T12:20:02.000Z',
      '1',
      '',
      '0.081370000',
    ]);
  });
});

describe('Excel export', () => {
  it('reads back with numbers as numbers, dates as dates and text untouched', async () => {
    const blob = await toXlsx(dispatchColumns(['USDC', 'SOL']), DISPATCHES);
    const rows = await readSheet(blob);
    expect(rows[0]).toEqual([
      'Id',
      'Mode',
      'Chain',
      'Status',
      'Created',
      'Items',
      'USDC total',
      'SOL total',
    ]);
    expect(rows[1]).toEqual([
      '7f3a91c2',
      'managed',
      'Base',
      'Broadcasting',
      new Date('2026-10-31T14:02:11Z'),
      37,
      12480,
      null,
    ]);
    expect(rows[2]![7]).toBe(0.08137);
  });

  it('keeps a formula-looking string as a string', async () => {
    const rows = await readSheet(await toXlsx(ITEM_COLUMNS, ITEMS));
    expect(rows[2]![2]).toBe('=HYPERLINK("http://evil.example","x")');
  });

  it('writes an amount as a number only when the number is exact, else as exact text', async () => {
    const rows = await readSheet(await toXlsx(ITEM_COLUMNS, ITEMS));
    expect(rows[1]![4]).toBe(1284.5);
    expect(rows[2]![4]).toBe(17.256001);
    expect(rows[4]![4]).toBe('123456789.012345678901234567');
  });

  it('freezes the header row and formats amounts with the asset decimals', async () => {
    const blob = await toXlsx(dispatchColumns(['USDC', 'SOL']), DISPATCHES);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const sheetName = Object.keys(files).find((name) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
    )!;
    const sheet = strFromU8(files[sheetName]!);
    expect(sheet).toMatch(/<pane[^>]*ySplit="1"[^>]*state="frozen"/);
    const styles = strFromU8(files['xl/styles.xml']!);
    expect(styles).toContain('formatCode="#,##0.00"');
    expect(styles).toContain('formatCode="#,##0.0000"');
  });
});

describe('file names', () => {
  it('names a list export by its date range and an items export by its Dispatch', () => {
    expect(dispatchesFileName({ from: '2026-10-01', to: '2026-10-31' }, 'csv')).toBe(
      'dispatches-2026-10-01_2026-10-31.csv',
    );
    expect(itemsFileName('7f3a91c2', 'xlsx')).toBe('dispatch-7f3a91c2-items.xlsx');
  });
});
