import type { Area, CheckResult, Fix } from './check.js';
import { AREAS } from './check.js';
import type { CheckOutcome } from './run.js';

export const AREA_NAMES: Record<Area, string> = {
  configuration: 'Configuration',
  database: 'Database',
  chain: 'Chain',
  signer: 'Signer',
  sender: 'Sender',
  multisig: 'Multisig',
  console: 'Console',
};

/** Every status carries its text label, so the report reads the same without colour. */
const MARKS: Record<CheckResult['status'], { mark: string; label: string; color: Paint }> = {
  pass: { mark: '✓', label: 'PASS', color: 'green' },
  warn: { mark: '!', label: 'WARN', color: 'yellow' },
  fail: { mark: '✗', label: 'FAIL', color: 'red' },
};

type Paint = 'green' | 'yellow' | 'red' | 'bold' | 'dim';
const ANSI: Record<Paint, [number, number]> = {
  green: [32, 39],
  yellow: [33, 39],
  red: [31, 39],
  bold: [1, 22],
  dim: [2, 22],
};

export type Painter = (paint: Paint, text: string) => string;

export function painter(color: boolean): Painter {
  return color
    ? (paint, text) => `\x1b[${ANSI[paint][0]}m${text}\x1b[${ANSI[paint][1]}m`
    : (_, text) => text;
}

/** Under the title: two spaces, the six-character mark and label, two spaces. */
const FIX_INDENT = ' '.repeat(10);

export type Summary = { passed: number; warnings: number; problems: number };

export function summarize(outcomes: readonly CheckOutcome[]): Summary {
  const count = (status: CheckResult['status']) =>
    outcomes.filter((outcome) => outcome.result.status === status).length;
  return { passed: count('pass'), warnings: count('warn'), problems: count('fail') };
}

export function summaryLine({ passed, warnings, problems }: Summary): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${passed} passed, ${plural(warnings, 'warning', 'warnings')}, ${plural(problems, 'problem', 'problems')}`;
}

export function fixText(fix: Fix): string {
  if ('command' in fix) return `run ${fix.command}`;
  if ('setting' in fix) return `set ${fix.setting} to ${fix.value}`;
  return fix.step;
}

/** Grouped by area, one line per check, its fix indented under it, and a summary line. */
export function renderHuman(outcomes: readonly CheckOutcome[], paint: Painter): string {
  const width = Math.max(0, ...outcomes.map((outcome) => outcome.title.length));
  const lines: string[] = [];
  for (const area of AREAS) {
    const inArea = outcomes.filter((outcome) => outcome.area === area);
    if (inArea.length === 0) continue;
    lines.push(paint('bold', AREA_NAMES[area]));
    for (const { title, result } of inArea) {
      const { mark, label, color } = MARKS[result.status];
      lines.push(
        `  ${paint(color, `${mark} ${label}`)}  ${title.padEnd(width)}  ${result.finding}`,
      );
      if (result.status !== 'pass') {
        lines.push(`${FIX_INDENT}${paint('dim', 'fix:')} ${fixText(result.fix)}`);
      }
    }
    lines.push('');
  }
  const summary = summarize(outcomes);
  const color: Paint = summary.problems > 0 ? 'red' : summary.warnings > 0 ? 'yellow' : 'green';
  lines.push(paint(color, summaryLine(summary)));
  return `${lines.join('\n')}\n`;
}

export function renderJson(outcomes: readonly CheckOutcome[]): string {
  return `${JSON.stringify(
    {
      summary: summarize(outcomes),
      checks: outcomes.map(({ id, area, title, chain, result }) => ({
        id,
        area,
        title,
        ...(chain ? { chain } : {}),
        ...result,
      })),
    },
    null,
    2,
  )}\n`;
}
