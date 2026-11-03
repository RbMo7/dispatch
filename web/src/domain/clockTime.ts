import type { FlowClock } from './dispatchFlow';

const today = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const otherDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const otherYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * A time as the console shows it, in the viewer's time zone: "11:25:16" today, "Nov 5, 11:25" on
 * another day, and "Jan 2, 2027, 08:05" in another year.
 */
export function clockTime(at: Date, now: Date): string {
  if (sameDay(at, now)) return today.format(at);
  return (at.getFullYear() === now.getFullYear() ? otherDay : otherYear).format(at);
}

/** The console's clock for a Dispatch's flow, read at `now`. */
export function consoleClock(now: Date): FlowClock {
  return { now, time: (at) => clockTime(at, now) };
}
