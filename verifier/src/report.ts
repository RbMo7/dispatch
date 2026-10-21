import { totalsByAsset, type Comparison, type Item } from './compare.js';

export type Verdict = 'MATCH' | 'MISMATCH';

/** Everything the CLI prints, kept as data so tests can assert on it. */
export interface Report {
  verdict: Verdict;
  /** Facts the Approver must confirm for themselves (addresses, chain, status...). */
  facts: [string, string][];
  /** Why the verdict is MISMATCH (empty for MATCH). */
  problems: string[];
  /** Notes that do not change the verdict. */
  notes: string[];
  comparison?: Comparison;
  /** What the proposal pays, after decoding. */
  proposalItems?: Item[];
  fileItems?: Item[];
  /** Safe only: the chunk of the file that matched. */
  chunk?: { index: number; of: number; firstLine: number; lastLine: number };
}

const short = (a: string) => (a.length > 20 ? `${a.slice(0, 6)}...${a.slice(-6)}` : a);

function line(i: Item): string {
  return `${i.recipient}  ${i.asset === 'native' ? 'native' : i.asset}  ${i.amount}`;
}

export function render(report: Report): string {
  const out: string[] = [];
  out.push(report.verdict);
  out.push('');
  for (const [k, v] of report.facts) out.push(`${(k + ':').padEnd(21)}${v}`);
  if (report.chunk) {
    out.push(
      `${'Matched chunk:'.padEnd(21)}${report.chunk.index} of ${report.chunk.of} (file payments ${report.chunk.firstLine} to ${report.chunk.lastLine})`,
    );
  }
  if (report.problems.length > 0) {
    out.push('', 'Problems:');
    for (const p of report.problems) out.push(`  - ${p}`);
  }
  const c = report.comparison;
  if (c) {
    out.push('', 'Payments (recipient  asset  amount in base units):');
    for (const m of c.matched) out.push(`  ok        ${line(m)}`);
    for (const m of c.mismatches) {
      if (m.kind === 'amount' && m.file) {
        out.push(
          `  CHANGED   ${line(m.proposal)}   (file line ${m.file.position} says amount ${m.file.amount})`,
        );
      } else if (m.kind === 'asset' && m.file) {
        out.push(
          `  WRONG ASSET ${line(m.proposal)}   (file line ${m.file.position} says asset ${m.file.asset})`,
        );
      } else out.push(`  EXTRA     ${line(m.proposal)}   (not in your file)`);
    }
    if (c.uncovered.length > 0 && report.chunk === undefined) {
      out.push(
        '',
        `Not paid by this proposal (${c.uncovered.length} file payments; expected if they belong to another proposal):`,
      );
      const shown = c.uncovered.slice(0, 20);
      for (const u of shown) out.push(`  line ${String(u.position).padEnd(6)}${line(u)}`);
      if (c.uncovered.length > shown.length)
        out.push(`  ... and ${c.uncovered.length - shown.length} more`);
    }
  }
  if (report.proposalItems && report.fileItems) {
    out.push('', 'Totals per asset (base units):');
    const prop = new Map(totalsByAsset(report.proposalItems).map((t) => [t.asset, t]));
    const file = new Map(totalsByAsset(report.fileItems).map((t) => [t.asset, t]));
    const assets = [...new Set([...prop.keys(), ...file.keys()])].sort();
    for (const a of assets) {
      const p = prop.get(a);
      const f = file.get(a);
      out.push(
        `  ${a === 'native' ? 'native' : short(a)}: proposal ${p ? `${p.count} payments, ${p.total}` : 'none'}; file ${f ? `${f.count} payments, ${f.total}` : 'none'}`,
      );
    }
    const covered = c ? c.matched.length : 0;
    const pct =
      report.fileItems.length > 0 ? Math.round((covered / report.fileItems.length) * 100) : 0;
    out.push(
      '',
      `Coverage: this proposal pays ${covered} of the ${report.fileItems.length} payments in your file (${pct}%). The rest must be in other proposals.`,
    );
  }
  if (report.notes.length > 0) {
    out.push('', 'Notes:');
    for (const n of report.notes) out.push(`  - ${n}`);
  }
  out.push(
    '',
    report.verdict === 'MATCH'
      ? 'MATCH covers the payments only. Confirm the multisig / Safe address above is yours before you vote.'
      : 'Do NOT approve this proposal until the differences above are explained.',
  );
  return out.join('\n');
}
