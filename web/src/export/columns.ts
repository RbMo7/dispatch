import { CHAINS } from '../domain/chains';
import {
  type DispatchSummary,
  type Item,
  itemAmount,
  itemAsset,
  itemTarget,
} from '../domain/dispatch';
import { STATUSES } from '../domain/status';
import { amount, date, type ExportColumn, integer, text } from './table';

/** Items of one Dispatch (design.md, Export). */
export const ITEM_COLUMNS: readonly ExportColumn<Item>[] = [
  { header: 'Index', width: 8, cell: (item) => integer(item.index) },
  { header: 'Type', width: 10, cell: (item) => text(item.type) },
  { header: 'Recipient or target', width: 46, cell: (item) => text(itemTarget(item)) },
  { header: 'Asset', width: 8, cell: (item) => text(itemAsset(item)) },
  { header: 'Amount', width: 30, cell: (item) => amount(itemAmount(item)) },
  { header: 'Status', width: 18, cell: (item) => text(STATUSES[item.status].label) },
  { header: 'Transaction hash', width: 68, cell: (item) => text(item.transactionHash) },
  { header: 'Error code', width: 22, cell: (item) => text(item.error?.code ?? null) },
  { header: 'Error message', width: 60, cell: (item) => text(item.error?.message ?? null) },
];

/** The Dispatches list, with one total column per asset present in `assets`. */
export function dispatchColumns(assets: readonly string[]): ExportColumn<DispatchSummary>[] {
  return [
    { header: 'Id', width: 12, cell: (row) => text(row.id) },
    { header: 'Mode', width: 10, cell: (row) => text(row.mode) },
    { header: 'Chain', width: 10, cell: (row) => text(CHAINS[row.chain].label) },
    { header: 'Status', width: 18, cell: (row) => text(STATUSES[row.status].label) },
    { header: 'Created', width: 20, cell: (row) => date(row.createdAt) },
    { header: 'Items', width: 8, cell: (row) => integer(row.itemCount) },
    ...assets.map((asset): ExportColumn<DispatchSummary> => ({
      header: `${asset} total`,
      width: 30,
      cell: (row) => amount(row.totals.find((total) => total.asset === asset) ?? null),
    })),
  ];
}
