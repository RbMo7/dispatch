import { approvalProgress } from './approval';
import type { Money } from './assets';
import { type Chain, type Network, proposalApp, proposalUrl, txLink } from './chains';
import {
  type Approval,
  type ApprovalState,
  type Cancellation,
  type ChainRef,
  type DispatchError,
  type DispatchSummary,
  type EntryOf,
  type Item,
  type ItemStatus,
  type LoadedDispatch,
  type ManagedDetail,
  type RelayDetail,
  type TakenNonce,
  type TimelineEntry,
} from './dispatch';
import { type ErrorContext, errorContext, explainError } from './errors';
import type { Flow, Stage, StageKind, StageLink, Text } from './flow';

/** How the caller formats a clock time; the flow itself stays free of time zones. */
export interface FlowClock {
  now: Date;
  time: (at: Date) => string;
}

const count = new Intl.NumberFormat('en-US');
const n = (value: number) => count.format(value);
const plural = (value: number, noun: string) => `${n(value)} ${noun}${value === 1 ? '' : 's'}`;

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

function stage(kind: StageKind, title: string, rest: Omit<Stage, 'kind' | 'title'> = {}): Stage {
  return { kind, title, ...rest };
}

function explorer(network: Network, hash: string): StageLink[] {
  const link = txLink(network, hash);
  return link ? [link] : [];
}

function first<K extends TimelineEntry['kind']>(
  timeline: readonly TimelineEntry[],
  kind: K,
): EntryOf<K> | undefined {
  return timeline.find((e): e is EntryOf<K> => e.kind === kind);
}

function last<K extends TimelineEntry['kind']>(
  timeline: readonly TimelineEntry[],
  kind: K,
): EntryOf<K> | undefined {
  return timeline.findLast((e): e is EntryOf<K> => e.kind === kind);
}

function of<K extends TimelineEntry['kind']>(
  timeline: readonly TimelineEntry[],
  kind: K,
): EntryOf<K>[] {
  return timeline.filter((e): e is EntryOf<K> => e.kind === kind);
}

/** "Stage 3 of 5": the main line only, branches do not count. */
function position(stages: readonly Stage[], predicate: (s: Stage) => boolean): string {
  const main = stages.filter((s) => s.kind !== 'branch-done' && s.kind !== 'branch-failed');
  return `stage ${main.findIndex(predicate) + 1} of ${main.length}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function expired(error: DispatchError | null): boolean {
  return error?.message.includes('expired') ?? false;
}

/** Texts end to end, neighbouring strings merged, so a sentence stays one string around its amounts. */
function join(...texts: Text[]): Text {
  const parts: (string | Money)[] = [];
  for (const part of texts.flatMap((text) => (typeof text === 'string' ? [text] : text))) {
    const last = parts.at(-1);
    if (typeof part === 'string' && typeof last === 'string') parts[parts.length - 1] = last + part;
    else parts.push(part);
  }
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
}

/** The catalogue's explanation of an error and what to do next. */
function errorText(error: DispatchError | null, ctx: ErrorContext): Text {
  if (!error) return 'The chain refused it.';
  const { text, next } = explainError(error, ctx);
  return join(text, ' ', next);
}

function errorLinks(error: DispatchError | null | undefined, ctx: ErrorContext): StageLink[] {
  const fix = error ? explainError(error, ctx).fix : null;
  return fix ? [fix] : [];
}

/** "37 payments, 12,480.00 USDC", with each total as an amount. */
function submitted(summary: DispatchSummary, items: readonly Item[]): Text {
  const payments = items.filter((i) => i.type === 'payment').length;
  const calls = items.length - payments;
  const what = [
    payments > 0 ? plural(payments, 'payment') : '',
    calls > 0 ? plural(calls, 'call') : '',
  ]
    .filter(Boolean)
    .join(' and ');
  const parts: (string | Money)[] = [what];
  summary.totals.forEach((total, index) => parts.push(index === 0 ? ', ' : ' and ', total));
  return parts;
}

function waitingStages(clock: FlowClock, created: Date): { stages: Stage[]; summary: string } {
  return {
    summary: 'waiting for the worker',
    stages: [
      stage('current', 'Waiting to be claimed', {
        at: 'now',
        detail: `Queued for ${duration(clock.now.getTime() - created.getTime())}. Nothing has been signed, so it can still be cancelled.`,
      }),
    ],
  };
}

function cancelledFlow(
  base: Stage[],
  at: Date | undefined,
  clock: FlowClock,
  cancellation: Cancellation | null | undefined,
): Flow {
  const by = cancellation
    ? ` Cancelled with the ${cancellation.tokenKind === 'operator' ? 'operator token' : 'API token'}${cancellation.reason ? `: ${cancellation.reason}` : ', no reason given'}.`
    : '';
  return {
    summary: 'Cancelled before it was claimed',
    elapsed: at ? `Ended at ${clock.time(at)}` : 'Cancelled',
    stages: [
      ...base,
      stage('end-cancelled', 'Cancelled', {
        ...(at && { at: clock.time(at) }),
        detail: `Withdrawn before the engine claimed it, so nothing was signed or sent.${by}`,
      }),
    ],
  };
}

function heldFlow(base: Stage[], created: Date, clock: FlowClock): Flow {
  const stages = [
    ...base,
    stage('current', 'Held', {
      at: clock.time(created),
      detail: 'It matched a Flag Rule. Nothing is signed until an operator releases it.',
    }),
    stage('todo', 'Claimed'),
    stage('todo', 'Signed and sent'),
    stage('todo', 'Confirmed'),
    stage('end-todo', 'Transaction hash'),
  ];
  return {
    summary: `${capitalise(position(stages, (s) => s.kind === 'current'))}, held for review`,
    elapsed: `Held for ${duration(clock.now.getTime() - created.getTime())}`,
    stages,
  };
}

/** Squads shows a Proposal by its transaction index, a Safe by its nonce. */
export function proposalName(ref: ChainRef): string {
  return ref.kind === 'squads' ? `#${ref.transactionIndex}` : `nonce ${ref.nonce}`;
}

function openProposal(network: Network, ref: ChainRef): StageLink[] {
  const href = proposalUrl(network, ref);
  return href ? [{ label: `Open ${proposalName(ref)} in ${proposalApp(ref)}`, href }] : [];
}

interface ProposalState {
  id: string;
  createdAt: Date;
  chainRef: ChainRef;
  items: number[];
  approvals: number;
  threshold: number;
  state: ApprovalState;
  decidedAt: Date | null;
  timedOutAt: Date | null;
  resolved: { at: Date; outcome: 'executed' | 'rejected' | 'failed' } | null;
  /** The latest approval block its items carry: who can approve, and how many more are needed. */
  approval: Approval | null;
}

function proposals(timeline: readonly TimelineEntry[], items: readonly Item[]): ProposalState[] {
  return of(timeline, 'proposal_created').map((created) => {
    const id = created.proposalId;
    const approval = timeline.findLast(
      (e): e is EntryOf<'proposal_approval'> =>
        e.kind === 'proposal_approval' && e.proposalId === id,
    );
    const timedOut = timeline.find((e) => e.kind === 'proposal_timed_out' && e.proposalId === id);
    const resolved = timeline.find(
      (e): e is EntryOf<'proposal_resolved'> =>
        e.kind === 'proposal_resolved' && e.proposalId === id,
    );
    return {
      id,
      createdAt: created.at,
      chainRef: created.chainRef,
      items: created.items,
      approvals: approval?.approvals ?? 0,
      threshold: approval?.threshold ?? 0,
      state: approval?.state ?? 'awaiting',
      decidedAt: approval?.at ?? null,
      timedOutAt: timedOut?.at ?? null,
      resolved: resolved ? { at: resolved.at, outcome: resolved.outcome } : null,
      approval: items[created.items[0] ?? -1]?.approval ?? null,
    };
  });
}

/** A Proposal's Approvers, for its stage; nothing when the engine has not read them yet. */
function approversOf(p: ProposalState): Pick<Stage, 'approvers'> {
  return p.approval && p.approval.approvers.length > 0 ? { approvers: p.approval.approvers } : {};
}

function approvalStages(
  detail: ManagedDetail,
  open: boolean,
  clock: FlowClock,
  network: Network,
): { stages: Stage[]; waiting: boolean } {
  const all = proposals(detail.timeline, detail.items);
  const total = detail.items.length;
  const inProposal = new Set(all.flatMap((p) => p.items)).size;
  const app = all[0] ? proposalApp(all[0].chainRef) : 'the multisig app';
  const stages: Stage[] = [];

  if (all.length === 0) {
    stages.push(
      stage(open ? 'current' : 'todo', 'Proposed', {
        ...(open && { at: 'now' }),
        detail: 'Not in a Proposal yet. A Safe holds one open Proposal at a time.',
      }),
    );
    stages.push(stage('todo', 'Approved'));
    return { stages, waiting: open };
  }

  const firstProposal = all[0]!;
  stages.push(
    stage(open && inProposal < total ? 'current' : 'done', 'Proposed', {
      at: clock.time(firstProposal.createdAt),
      detail:
        all.length === 1
          ? `Proposal ${proposalName(firstProposal.chainRef)} in ${app} holds ${plural(firstProposal.items.length, 'transfer')}`
          : `${n(all.length)} Proposals in ${app} hold ${plural(inProposal, 'transfer')}`,
      ...(total > 1 && inProposal < total && { count: { reached: inProposal, of: total } }),
    }),
  );

  const rejected = all.filter((p) => p.resolved?.outcome === 'rejected');
  const late = all.filter((p) => p.state === 'approved_after_deadline');
  const timedOut = all.filter((p) => p.timedOutAt && p.state !== 'approved_after_deadline');
  const awaiting = all.filter((p) => p.state === 'awaiting' && !p.timedOutAt && !p.resolved);
  const approved = all.filter((p) => p.state === 'approved');

  if (all.length === 1) {
    const p = firstProposal;
    if (rejected.length > 0) {
      stages.push(
        stage('failed', 'Rejected', {
          at: clock.time(p.resolved!.at),
          detail: `The Approvers rejected or cancelled it in ${app}. Nothing was paid.`,
          ...approversOf(p),
          links: openProposal(network, p.chainRef),
        }),
      );
    } else if (late.length > 0) {
      stages.push(
        stage('failed', 'Approved after the deadline', {
          ...(p.timedOutAt && { at: clock.time(p.timedOutAt) }),
          detail: `The engine will not execute it. Execute or reject it in ${app} yourself.`,
          ...approversOf(p),
          links: openProposal(network, p.chainRef),
        }),
      );
    } else if (timedOut.length > 0) {
      stages.push(
        stage('failed', 'Timed out', {
          at: clock.time(p.timedOutAt!),
          detail: `Nobody decided by the deadline, so the engine will not execute it. It may still be approved and executed in ${app}: check there before sending it again.`,
          ...approversOf(p),
          links: openProposal(network, p.chainRef),
        }),
      );
    } else if (awaiting.length > 0) {
      const deadline = p.approval?.deadline;
      stages.push(
        stage(
          'current',
          approvalProgress(
            p.approval ?? { ...p, remaining: Math.max(0, p.threshold - p.approvals) },
          ),
          {
            at: 'now',
            detail: deadline
              ? `Deadline ${clock.time(deadline)}, in ${duration(deadline.getTime() - clock.now.getTime())}. The engine never approves.`
              : 'The engine never approves.',
            ...approversOf(p),
            links: openProposal(network, p.chainRef),
          },
        ),
      );
    } else {
      stages.push(
        stage('done', `Approved, ${p.approvals} of ${p.threshold}`, {
          ...(p.decidedAt && { at: clock.time(p.decidedAt) }),
          ...approversOf(p),
          links: openProposal(network, p.chainRef),
        }),
      );
    }
    return { stages, waiting: awaiting.length > 0 };
  }

  const ended = rejected.length + late.length + timedOut.length;
  const next = awaiting[0];
  stages.push(
    stage(
      awaiting.length > 0 ? 'current' : ended === all.length ? 'failed' : 'done',
      `Approved, ${n(approved.length)} of ${n(all.length)} Proposals`,
      {
        ...(awaiting.length > 0 && { at: 'now' }),
        count: { reached: approved.length, of: all.length },
        detail:
          ended > 0
            ? `${n(ended)} ended without approval: ${n(timedOut.length)} timed out, ${n(rejected.length)} rejected, ${n(late.length)} approved too late.`
            : next?.approval
              ? `Next, ${proposalName(next.chainRef)}: ${approvalProgress(next.approval)}. The engine never approves.`
              : 'The engine never approves.',
        ...(next && approversOf(next)),
        ...(next && { links: openProposal(network, next.chainRef) }),
      },
    ),
  );
  return { stages, waiting: awaiting.length > 0 };
}

function hashLinks(network: Network, hash: string, landed: number): StageLink[] {
  return landed > 1
    ? [...explorer(network, hash), { label: 'Show all in Items', items: 'confirmed' }]
    : explorer(network, hash);
}

function managedFlow(
  summary: DispatchSummary,
  detail: ManagedDetail,
  clock: FlowClock,
  network: Network,
): Flow {
  const { timeline, items } = detail;
  const chain = summary.chain;
  const total = items.length;
  const created = first(timeline, 'created')?.at ?? summary.createdAt;
  const base = [
    stage('done', 'Submitted', { at: clock.time(created), detail: submitted(summary, items) }),
  ];

  if (detail.status === 'cancelled') {
    return cancelledFlow(base, first(timeline, 'cancelled')?.at, clock, detail.cancellation);
  }
  if (detail.status === 'held') return heldFlow(base, created, clock);

  const claimed = last(timeline, 'claimed');
  const tally = new Map<ItemStatus, number>();
  for (const item of items) tally.set(item.status, (tally.get(item.status) ?? 0) + 1);
  const t = (status: ItemStatus) => tally.get(status) ?? 0;
  const confirmed = t('confirmed');
  const open = t('queued') + t('broadcasting') + t('awaiting_approval') > 0;

  if (!claimed) {
    const waiting = waitingStages(clock, created);
    const stages = [
      ...base,
      ...waiting.stages,
      stage('todo', 'Signed and sent'),
      stage('todo', 'Confirmed'),
      stage('end-todo', 'Transaction hash', { detail: 'Appears once it lands' }),
    ];
    return {
      summary: `${capitalise(position(stages, (s) => s.kind === 'current'))}, ${waiting.summary}`,
      elapsed: `${duration(clock.now.getTime() - created.getTime())} so far`,
      stages,
    };
  }

  const stages: Stage[] = [...base];
  const errors = errorContext(chain, detail.sender, items);
  const unfunded = items.filter(
    (i) => i.status === 'failed' && i.error?.code === 'INSUFFICIENT_FUNDS',
  );
  stages.push(
    stage('done', 'Claimed', {
      at: clock.time(claimed.at),
      ...(unfunded.length === 0 && { detail: 'Funding Check passed' }),
    }),
  );
  const shortfall = fundingShortfall(unfunded, errors);
  // When nothing was funded the outcome stage says so; a branch would repeat it.
  if (unfunded.length > 0 && unfunded.length < total) {
    stages.push(
      stage('branch-failed', `Funding Check failed, ${n(unfunded.length)}`, {
        at: clock.time(claimed.at),
        detail: shortfall,
        links: [
          { label: 'Show in Items', items: 'failed' },
          ...errorLinks(unfunded[0]?.error, errors),
        ],
      }),
    );
  }

  const multisig = items.some((i) => i.approval !== null) || first(timeline, 'proposal_created');
  let waitingOnApprovers = false;
  if (multisig) {
    const approval = approvalStages(detail, open, clock, network);
    stages.push(...approval.stages);
    waitingOnApprovers = approval.waiting;
  }

  const written = of(timeline, 'written');
  const sentItems = new Set(written.flatMap((w) => w.items)).size;
  const versions = written.filter((w) => w.replaces === null);
  const attempts = of(timeline, 'attempt').length;
  const toSend = total - unfunded.length;
  const reachedCurrent = stages.some((s) => s.kind === 'current');
  const sendKind: StageKind =
    sentItems === 0
      ? open && !reachedCurrent
        ? 'current'
        : 'todo'
      : open && sentItems < toSend
        ? 'current'
        : 'done';
  const sendDetail: string[] = [];
  if (versions.length > 0) {
    sendDetail.push(
      versions.length < sentItems
        ? `${plural(versions.length, 'transaction')} ${versions.length === 1 ? 'carries' : 'carry'} ${plural(sentItems, 'item')}`
        : plural(versions.length, 'transaction'),
    );
  }
  if (attempts > 0) sendDetail.push(`sent again ${plural(attempts, 'time')} while waiting`);
  stages.push(
    stage(sendKind, multisig ? 'Executed' : 'Signed and sent', {
      ...(written[0]
        ? { at: sendKind === 'current' ? 'now' : clock.time(written[0].at) }
        : sendKind === 'current'
          ? { at: 'now' }
          : {}),
      ...(sendDetail.length > 0
        ? { detail: capitalise(sendDetail.join(', ')) }
        : multisig && sentItems === 0
          ? { detail: 'The engine executes once the threshold is met' }
          : {}),
      ...(total > 1 && sentItems > 0 && { count: { reached: sentItems, of: total } }),
    }),
  );

  const taken = of(timeline, 'dropped').filter((d) => d.taken !== null);
  if (taken.length > 0) {
    stages.push(
      stage(
        'branch-done',
        taken.length === 1 ? 'Nonce taken' : `Nonces taken, ${n(taken.length)}`,
        {
          at: clock.time(taken[0]!.at),
          detail: takenDetail(taken.map((d) => d.taken!)),
        },
      ),
    );
  }

  // A resend at a fresh nonce replaces the taken version too, but it is no fee bump.
  const resent = new Set(taken.flatMap((d) => (d.by ? [d.by] : [])));
  const repriced = written.filter((w) => w.replaces !== null && !resent.has(w.hash));
  if (repriced.length > 0) {
    const solana = chain === 'solana';
    const one = repriced.length === 1 ? repriced[0]! : null;
    stages.push(
      stage(
        'branch-done',
        solana
          ? one
            ? 'Resubmitted'
            : `Resubmitted, ${n(repriced.length)}`
          : one
            ? 'Fee bumped'
            : `Fee bumped, ${n(repriced.length)}`,
        {
          at: clock.time(repriced[0]!.at),
          detail: solana
            ? 'The blockhash expired before it landed, so the engine signed it again with a fresh one. The expired version can never land and cost nothing.'
            : one
              ? `No block in time, so it was repriced at the same nonce: ${shortHash(one.replaces!)} replaced by ${shortHash(one.hash)}.`
              : 'No block in time, so these were repriced at the same nonce.',
        },
      ),
    );
  }

  const failures = items.filter(
    (i) => i.status === 'failed' && i.error?.code !== 'INSUFFICIENT_FUNDS',
  );
  if (total > 1 && failures.length > 0) {
    const at = first(timeline, 'failed')?.at;
    stages.push(
      stage('branch-failed', `Item failures, ${n(failures.length)}`, {
        ...(at && { at: clock.time(at) }),
        detail:
          failures.length === 1
            ? errorText(failures[0]!.error, errors)
            : [
                ...new Set(
                  failures.map((i) =>
                    i.error ? explainError(i.error, errors).line : 'The chain refused it',
                  ),
                ),
              ].join(', '),
        links: [
          { label: 'Show in Items', items: 'failed' },
          ...(failures.length === 1 ? errorLinks(failures[0]!.error, errors) : []),
        ],
      }),
    );
  }
  const abandoned = items.filter(
    (i) => i.status === 'abandoned' && i.error?.code !== 'APPROVAL_TIMEOUT',
  );
  if (total > 1 && abandoned.length > 0) {
    const at = first(timeline, 'abandoned')?.at;
    stages.push(
      stage('branch-failed', `Abandoned, ${n(abandoned.length)}`, {
        ...(at && { at: clock.time(at) }),
        detail:
          'No answer from the chain before the timeout. These may still land, so check before sending them again.',
        links: [{ label: 'Show in Items', items: 'abandoned' }],
      }),
    );
  }

  const confirmedAt = last(timeline, 'confirmed')?.at;
  const stopped = stages.some((s) => s.kind === 'failed');
  const outcomeKind: StageKind = open
    ? sentItems > 0 && !waitingOnApprovers
      ? 'current'
      : 'todo'
    : confirmed > 0
      ? 'done'
      : stopped
        ? 'todo'
        : 'failed';
  const failure = items.find((i) => i.status === 'failed' || i.status === 'abandoned');
  const outcomeTitle =
    outcomeKind === 'failed'
      ? failure?.status === 'abandoned'
        ? 'Abandoned'
        : expired(failure?.error ?? null)
          ? 'Expired'
          : 'Failed'
      : 'Confirmed';
  stages.push(
    stage(outcomeKind, outcomeTitle, {
      ...(outcomeKind === 'current'
        ? { at: 'now' }
        : outcomeKind === 'done' && confirmedAt
          ? { at: clock.time(confirmedAt) }
          : outcomeKind === 'failed'
            ? (() => {
                const at = last(timeline, 'failed')?.at ?? last(timeline, 'abandoned')?.at;
                return at ? { at: clock.time(at) } : {};
              })()
            : {}),
      ...(outcomeKind === 'current' && { detail: 'Waiting for a block' }),
      ...(outcomeKind === 'failed' &&
        failure && {
          detail: unfunded.length === total ? shortfall : outcomeDetail(failure, chain, errors),
          links: errorLinks(failure.error, errors),
        }),
      ...(total > 1 &&
        outcomeKind !== 'failed' &&
        (confirmed > 0 || outcomeKind === 'current') && {
          count: { reached: confirmed, of: total },
        }),
    }),
  );

  const landed = [
    ...new Set(
      items.flatMap((i) =>
        i.status === 'confirmed' && i.transactionHash ? [i.transactionHash] : [],
      ),
    ),
  ];
  const firstHash = landed[0];
  if (open) {
    stages.push(
      firstHash
        ? stage('end-todo', 'Transaction hashes', {
            detail: `${n(landed.length)} landed so far. The first one:`,
            hash: firstHash,
            links: hashLinks(network, firstHash, landed.length),
          })
        : stage('end-todo', 'Transaction hash', {
            detail: multisig ? 'Appears after execution' : 'Appears once it lands',
          }),
    );
  } else if (firstHash) {
    stages.push(
      stage(
        'end-done',
        landed.length === 1 ? 'Transaction hash' : `${n(landed.length)} transaction hashes`,
        {
          ...(landed.length > 1 && { detail: 'The first one, the rest are under Items' }),
          hash: firstHash,
          links: hashLinks(network, firstHash, landed.length),
        },
      ),
    );
  } else {
    stages.push(
      stage('end-failed', 'No transaction landed', {
        detail: multisig
          ? 'Nothing was executed.'
          : 'Nothing confirmed on chain for this Dispatch.',
      }),
    );
  }

  const end = confirmedAt ?? last(timeline, 'failed')?.at ?? last(timeline, 'abandoned')?.at;
  let line: string;
  if (open) {
    const current = stages.find((s) => s.kind === 'current');
    const phrase = waitingOnApprovers
      ? 'waiting on Approvers'
      : total > 1 && confirmed > 0
        ? `${n(confirmed)} of ${n(total)} confirmed`
        : current?.title === 'Confirmed'
          ? 'waiting for a block'
          : 'sending';
    line = current
      ? `${capitalise(position(stages, (s) => s === current))}, ${phrase}`
      : capitalise(phrase);
  } else if (confirmed === total) {
    line = end ? `Done in ${duration(end.getTime() - created.getTime())}` : 'Done';
  } else if (confirmed > 0) {
    line = `${n(confirmed)} of ${n(total)} confirmed`;
  } else {
    line = `Failed at ${position(stages, (s) => s.kind === 'failed')}`;
  }
  return {
    summary: line,
    elapsed: open
      ? `${duration(clock.now.getTime() - created.getTime())} so far`
      : end
        ? `${confirmed === total ? 'Confirmed' : 'Ended'} at ${clock.time(end)}`
        : 'Ended',
    stages,
  };
}

/** "payouts is short 11.1158 SOL. Fund 0x8b21…44fe.", with the shortfall as an amount when its decimals are known. */
function fundingShortfall(unfunded: readonly Item[], ctx: ErrorContext): Text {
  const error = unfunded[0]?.error;
  return error
    ? join(explainError(error, ctx).text, ' Nothing was signed.')
    : 'The Funding Check found the Sender could not cover it. Nothing was signed.';
}

function outcomeDetail(item: Item, chain: Chain, ctx: ErrorContext): Text {
  if (item.status === 'abandoned') {
    return item.error?.code === 'APPROVAL_TIMEOUT'
      ? 'Nobody approved it in time.'
      : 'No answer from the chain before the timeout. It may still land, so check before sending it again.';
  }
  if (expired(item.error)) {
    return chain === 'solana'
      ? 'Its blockhash expired three times without landing.'
      : 'It expired without landing.';
  }
  return errorText(item.error, ctx);
}

/** ADR-0064: "Nonce 8 was taken by another sender. Sent again with nonce 12." */
function takenDetail(taken: readonly TakenNonce[]): string {
  if (taken.length === 1) {
    const { nonce, resentNonce } = taken[0]!;
    const was = nonce === null ? 'Its nonce' : `Nonce ${nonce}`;
    const again = resentNonce === null ? 'a fresh nonce' : `nonce ${resentNonce}`;
    return `${was} was taken by another sender. Sent again with ${again}.`;
  }
  const known = taken.flatMap((t) => (t.nonce === null ? [] : [t.nonce]));
  const range =
    known.length === taken.length ? `, ${Math.min(...known)} to ${Math.max(...known)}` : '';
  return `Another sender took ${n(taken.length)} nonces${range}. The engine sent each of those again with a fresh nonce.`;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

function relayFlow(
  summary: DispatchSummary,
  detail: RelayDetail,
  clock: FlowClock,
  network: Network,
): Flow {
  const { timeline, status } = detail;
  const created = first(timeline, 'created')?.at ?? summary.createdAt;
  const base = [
    stage('done', 'Received', {
      at: clock.time(created),
      detail: 'A transaction the caller signed. The engine only sends it and watches it.',
    }),
  ];
  if (status === 'cancelled') {
    return cancelledFlow(base, first(timeline, 'cancelled')?.at, clock, detail.cancellation);
  }

  const claimed = last(timeline, 'claimed');
  if (!claimed) {
    const waiting = waitingStages(clock, created);
    const stages = [
      ...base,
      ...waiting.stages,
      stage('todo', 'Sent'),
      stage('todo', 'Confirmed'),
      stage('end-todo', 'Transaction hash', { detail: 'Appears once it lands' }),
    ];
    return {
      summary: `${capitalise(position(stages, (s) => s.kind === 'current'))}, ${waiting.summary}`,
      elapsed: `${duration(clock.now.getTime() - created.getTime())} so far`,
      stages,
    };
  }

  const written = first(timeline, 'written');
  const attempts = of(timeline, 'attempt').length;
  const open = status === 'queued' || status === 'broadcasting';
  const stages: Stage[] = [...base, stage('done', 'Claimed', { at: clock.time(claimed.at) })];
  stages.push(
    stage(written ? 'done' : open ? 'current' : 'failed', 'Sent', {
      ...(written ? { at: clock.time(written.at) } : open ? { at: 'now' } : {}),
      detail:
        attempts > 0
          ? `Sent the same bytes ${plural(attempts + 1, 'time')} while it could still land`
          : written
            ? 'Accepted by the node'
            : 'Not sent yet',
    }),
  );

  const hash = detail.transactionHash;
  const outcome =
    last(timeline, 'confirmed') ?? last(timeline, 'failed') ?? last(timeline, 'abandoned');
  if (open) {
    stages.push(
      stage(
        written ? 'current' : 'todo',
        'Confirmed',
        written ? { at: 'now', detail: 'Waiting for a block' } : {},
      ),
    );
    stages.push(stage('end-todo', 'Transaction hash', { detail: 'Appears once it lands' }));
  } else if (status === 'confirmed') {
    stages.push(stage('done', 'Confirmed', outcome ? { at: clock.time(outcome.at) } : {}));
    if (hash)
      stages.push(stage('end-done', 'Transaction hash', { hash, links: explorer(network, hash) }));
  } else if (expired(detail.error)) {
    stages.push(
      stage('failed', 'Expired', {
        ...(outcome && { at: clock.time(outcome.at) }),
        detail: 'Its blockhash expired before it landed. The engine holds no key to sign it again.',
      }),
    );
    stages.push(
      stage('end-failed', 'No transaction landed', {
        detail: 'Ask the wallet that signed it for a fresh transaction.',
      }),
    );
  } else {
    const abandoned = status === 'abandoned';
    stages.push(
      stage('failed', abandoned ? 'Abandoned' : 'Failed', {
        ...(outcome && { at: clock.time(outcome.at) }),
        detail: abandoned
          ? 'No answer from the chain before the timeout. It may still land, so check before sending it again.'
          : errorText(detail.error, errorContext(detail.chain, null, [])),
        links: errorLinks(detail.error, errorContext(detail.chain, null, [])),
      }),
    );
    stages.push(
      hash
        ? stage('end-failed', 'Transaction hash', { hash, links: explorer(network, hash) })
        : stage('end-failed', 'No transaction landed'),
    );
  }

  return {
    summary: open
      ? `${capitalise(position(stages, (s) => s.kind === 'current'))}, ${written ? 'waiting for a block' : 'sending'}`
      : status === 'confirmed'
        ? outcome
          ? `Done in ${duration(outcome.at.getTime() - created.getTime())}`
          : 'Done'
        : `Failed at ${position(stages, (s) => s.kind === 'failed')}`,
    elapsed: open
      ? `${duration(clock.now.getTime() - created.getTime())} so far`
      : outcome
        ? `${status === 'confirmed' ? 'Confirmed' : 'Ended'} at ${clock.time(outcome.at)}`
        : 'Ended',
    stages,
  };
}

/** The Flow tab's stages for one Dispatch, from its items, statuses and timeline alone. */
export function dispatchFlow(
  { summary, detail }: LoadedDispatch,
  clock: FlowClock,
  network: Network,
): Flow {
  return detail.mode === 'relay'
    ? relayFlow(summary, detail, clock, network)
    : managedFlow(summary, detail, clock, network);
}
