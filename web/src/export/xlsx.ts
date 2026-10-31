import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/universal';

import { DISPLAY_DECIMALS, exactDecimal, type Money } from '../domain/assets';
import type { ExportCell, ExportColumn } from './table';

function amountCell(money: Money): Cell {
  const exact = exactDecimal(money);
  const number = Number(exact);
  if (money.decimals <= 100 && number.toFixed(money.decimals) === exact) {
    const shown = DISPLAY_DECIMALS[money.asset];
    const format = shown === undefined ? '#,##0.######' : shown > 0 ? `#,##0.${'0'.repeat(shown)}` : '#,##0';
    return { type: Number, value: number, format };
  }
  return { type: String, value: exact };
}

function cell(value: ExportCell): Cell {
  switch (value.type) {
    case 'text':
      return value.value === null ? null : { type: String, value: value.value };
    case 'integer':
      return { type: Number, value: value.value, format: '0' };
    case 'amount':
      return value.value === null ? null : amountCell(value.value);
    case 'date':
      return value.value === null
        ? null
        : { type: Date, value: value.value, format: 'yyyy-mm-dd hh:mm:ss' };
  }
}

/** One sheet, the header row frozen, amounts exact and dates as real dates. */
export function toXlsx<Row>(
  columns: readonly ExportColumn<Row>[],
  rows: readonly Row[],
  sheet = 'Export',
): Promise<Blob> {
  const data: SheetData = [
    columns.map((column) => ({ type: String, value: column.header, fontWeight: 'bold' as const })),
    ...rows.map((row) => columns.map((column) => cell(column.cell(row)))),
  ];
  return writeXlsxFile(data, {
    sheet,
    stickyRowsCount: 1,
    columns: columns.map((column) => ({ width: column.width })),
  }).toBlob();
}
