import type { DayRange } from '../domain/dateRange';
import { toCsv } from './csv';
import type { ExportColumn } from './table';
import { toXlsx } from './xlsx';

export type ExportFormat = 'csv' | 'xlsx';

export const EXPORT_FORMATS = [
  { id: 'csv', label: 'CSV' },
  { id: 'xlsx', label: 'Excel (.xlsx)' },
] as const satisfies readonly { id: ExportFormat; label: string }[];

/** `dispatches-2026-10-01_2026-10-31.csv` */
export function dispatchesFileName(range: DayRange, format: ExportFormat): string {
  return `dispatches-${range.from}_${range.to}.${format}`;
}

/** `dispatch-7f3a91c2-items.xlsx` */
export function itemsFileName(dispatchId: string, format: ExportFormat): string {
  return `dispatch-${dispatchId}-items.${format}`;
}

export async function exportFile<Row>(
  format: ExportFormat,
  columns: readonly ExportColumn<Row>[],
  rows: readonly Row[],
): Promise<Blob> {
  return format === 'csv'
    ? new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' })
    : toXlsx(columns, rows);
}

/** Saves a Blob built in the browser; nothing goes to the engine. */
export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
