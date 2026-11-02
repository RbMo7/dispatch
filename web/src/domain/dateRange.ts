/** Inclusive calendar days in the viewer's time zone, as `YYYY-MM-DD`. */
export interface DayRange {
  from: string;
  to: string;
}

export const PRESETS = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: 'custom', label: 'Custom', days: null },
] as const;

export type Preset = (typeof PRESETS)[number]['value'];

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function presetRange(preset: Exclude<Preset, 'custom'>, today: Date): DayRange {
  const days = PRESETS.find((p) => p.value === preset)!.days!;
  return { from: dayKey(addDays(today, 1 - days)), to: dayKey(today) };
}

/** Which preset a range is, or `custom` when it matches none. */
export function presetOf(range: DayRange, today: Date): Preset {
  for (const { value, days } of PRESETS) {
    if (days === null) continue;
    const candidate = presetRange(value, today);
    if (candidate.from === range.from && candidate.to === range.to) return value;
  }
  return 'custom';
}

export function inRange(range: DayRange, date: Date): boolean {
  const day = dayKey(date);
  return day >= range.from && day <= range.to;
}

const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "Oct 4 to Oct 17", or "Oct 4" for a single day. */
export function describeRange(range: DayRange): string {
  const from = short.format(parseDay(range.from));
  return range.from === range.to ? from : `${from} to ${short.format(parseDay(range.to))}`;
}
