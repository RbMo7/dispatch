export type StageKind =
  | 'done'
  | 'current'
  | 'todo'
  | 'failed'
  | 'branch-done'
  | 'branch-failed'
  | 'end-done'
  | 'end-todo'
  | 'end-failed'
  | 'end-cancelled';

export type Dot = 'check' | 'cross' | 'ring' | 'muted' | 'empty';
export type Box = 'plain' | 'current' | 'todo' | 'failed' | 'end' | 'end-todo';
export type Segment = 'done' | 'current' | 'todo' | 'failed' | 'cancelled';

interface StageLook {
  dot: Dot;
  box: Box;
  segment: Segment | null;
  reached: boolean;
  branch: boolean;
}

export const STAGE_LOOK = {
  done: { dot: 'check', box: 'plain', segment: 'done', reached: true, branch: false },
  current: { dot: 'ring', box: 'current', segment: 'current', reached: true, branch: false },
  todo: { dot: 'empty', box: 'todo', segment: 'todo', reached: false, branch: false },
  failed: { dot: 'cross', box: 'failed', segment: 'failed', reached: true, branch: false },
  'branch-done': { dot: 'check', box: 'plain', segment: null, reached: true, branch: true },
  'branch-failed': { dot: 'cross', box: 'failed', segment: null, reached: true, branch: true },
  'end-done': { dot: 'check', box: 'end', segment: 'done', reached: true, branch: false },
  'end-todo': { dot: 'empty', box: 'end-todo', segment: 'todo', reached: false, branch: false },
  'end-failed': { dot: 'cross', box: 'end', segment: 'failed', reached: true, branch: false },
  'end-cancelled': { dot: 'muted', box: 'end', segment: 'cancelled', reached: true, branch: false },
} as const satisfies Record<StageKind, StageLook>;

export interface StageLink {
  label: string;
  href?: string;
  onSelect?: () => void;
}

export interface Stage {
  kind: StageKind;
  title: string;
  /** Clock time, or "now" for the current stage. */
  at?: string;
  detail?: string;
  /** For a large Dispatch: how many items have reached this stage. */
  count?: { reached: number; of: number };
  hash?: string;
  links?: StageLink[];
}

export interface Flow {
  summary: string;
  elapsed: string;
  stages: Stage[];
}

export function stageSegments(stages: readonly Stage[]): Segment[] {
  return stages.flatMap((stage) => {
    const segment = STAGE_LOOK[stage.kind].segment;
    return segment ? [segment] : [];
  });
}
