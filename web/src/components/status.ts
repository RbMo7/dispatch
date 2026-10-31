// Every status a Dispatch or one of its items can report (docs/api.md), plus
// `held` from flag-rules. A tone names a --pill-<tone>-fg/-bg pair in tokens.css.
export type Tone =
  'neutral' | 'muted' | 'info' | 'attention' | 'success' | 'warning' | 'danger' | 'stale';

export type Glyph =
  'hollow-dot' | 'pulse-dot' | 'person' | 'pause' | 'check' | 'half' | 'cross' | 'clock' | 'slash';

export interface StatusLook {
  label: string;
  glyph: Glyph;
  tone: Tone;
}

export const STATUSES = {
  queued: { label: 'Queued', glyph: 'hollow-dot', tone: 'neutral' },
  broadcasting: { label: 'Broadcasting', glyph: 'pulse-dot', tone: 'info' },
  awaiting_approval: { label: 'Awaiting approval', glyph: 'person', tone: 'attention' },
  held: { label: 'Held', glyph: 'pause', tone: 'attention' },
  confirmed: { label: 'Confirmed', glyph: 'check', tone: 'success' },
  partial: { label: 'Partial', glyph: 'half', tone: 'warning' },
  failed: { label: 'Failed', glyph: 'cross', tone: 'danger' },
  abandoned: { label: 'Abandoned', glyph: 'clock', tone: 'stale' },
  cancelled: { label: 'Cancelled', glyph: 'slash', tone: 'muted' },
} as const satisfies Record<string, StatusLook>;

export type Status = keyof typeof STATUSES;

export const ALL_STATUSES = Object.keys(STATUSES) as Status[];
