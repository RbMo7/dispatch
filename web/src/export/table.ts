import type { Money } from '../domain/assets';

export type ExportCell =
  | { type: 'text'; value: string | null }
  | { type: 'integer'; value: number }
  | { type: 'amount'; value: Money | null }
  | { type: 'date'; value: Date | null };

export interface ExportColumn<Row> {
  header: string;
  /** Character width of the spreadsheet column. */
  width: number;
  cell: (row: Row) => ExportCell;
}

export const text = (value: string | null): ExportCell => ({ type: 'text', value });
export const integer = (value: number): ExportCell => ({ type: 'integer', value });
export const date = (value: Date | null): ExportCell => ({ type: 'date', value });
export const amount = (value: Money | null): ExportCell => ({ type: 'amount', value });
