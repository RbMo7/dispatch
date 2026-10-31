// Every status a Dispatch or one of its items can report (docs/api.md), plus
// `held` from flag-rules and `cancelled` from ADR-0056. Each names its pill's
// --pill-<status>-fg/-bg pair in tokens.css.
function pill<S extends string>(status: S) {
  return { color: `var(--pill-${status}-fg)`, backgroundColor: `var(--pill-${status}-bg)` } as const;
}

export const STATUSES = {
  queued: { label: 'Queued', pill: pill('queued') },
  broadcasting: { label: 'Broadcasting', pill: pill('broadcasting') },
  awaiting_approval: { label: 'Awaiting approval', pill: pill('awaiting_approval') },
  held: { label: 'Held', pill: pill('held') },
  confirmed: { label: 'Confirmed', pill: pill('confirmed') },
  partial: { label: 'Partial', pill: pill('partial') },
  failed: { label: 'Failed', pill: pill('failed') },
  abandoned: { label: 'Abandoned', pill: pill('abandoned') },
  cancelled: { label: 'Cancelled', pill: pill('cancelled') },
} as const;

export type Status = keyof typeof STATUSES;

export const ALL_STATUSES = Object.keys(STATUSES) as Status[];
