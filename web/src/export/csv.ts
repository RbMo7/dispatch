import { exactDecimal } from '../domain/assets';
import type { ExportCell, ExportColumn } from './table';

// A cell starting with one of these is read as a formula by Excel and
// Sheets; an apostrophe makes it plain text (OWASP CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

function field(cell: ExportCell): string {
  switch (cell.type) {
    case 'text': {
      if (cell.value === null) return '';
      const safe = FORMULA_START.test(cell.value) ? `'${cell.value}` : cell.value;
      return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
    }
    case 'integer':
      return String(cell.value);
    case 'amount':
      return cell.value === null ? '' : exactDecimal(cell.value);
    case 'date':
      return cell.value === null ? '' : cell.value.toISOString();
  }
}

/** RFC 4180: a header row, CRLF line ends, quoted fields; a BOM so Excel reads it as UTF-8. */
export function toCsv<Row>(columns: readonly ExportColumn<Row>[], rows: readonly Row[]): string {
  const header = columns.map((column) => field({ type: 'text', value: column.header }));
  const lines = rows.map((row) => columns.map((column) => field(column.cell(row))).join(','));
  return `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
