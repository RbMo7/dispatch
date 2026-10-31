import { Check, X } from '@phosphor-icons/react';

import { type Dot, type Flow, type Stage, STAGE_LOOK, type StageLink, stageSegments } from '../domain/flow';
import styles from './FlowGraph.module.css';
import { MonoValue } from './MonoValue';
import { StackedBar } from './StackedBar';

const SPOKEN: Record<Dot, string> = {
  check: 'Done',
  cross: 'Failed',
  ring: 'In progress',
  muted: 'Ended',
  empty: 'Not reached yet',
};

const count = new Intl.NumberFormat('en-US');

export function FlowGraph({ flow }: { flow: Flow }) {
  return (
    <div>
      <div className={styles.summary}>
        <span className={styles.summaryText}>{flow.summary}</span>
        <span className={styles.elapsed}>{flow.elapsed}</span>
      </div>
      <div className={styles.segments} aria-hidden="true">
        {stageSegments(flow.stages).map((segment, index) => (
          <span key={index} className={styles.segment} data-segment={segment} />
        ))}
      </div>
      <ol className={styles.graph}>
        {flow.stages.map((stage, index) => (
          <StageNode key={index} stage={stage} next={flow.stages[index + 1]} />
        ))}
      </ol>
    </div>
  );
}

function StageNode({ stage, next }: { stage: Stage; next: Stage | undefined }) {
  const look = STAGE_LOOK[stage.kind];
  const line = next === undefined ? undefined : STAGE_LOOK[next.kind].reached ? 'solid' : 'dashed';

  return (
    <li
      className={styles.node}
      data-dot={look.dot}
      data-box={look.box}
      data-branch={look.branch ? (look.dot === 'cross' ? 'failed' : 'done') : undefined}
      data-line={line}
    >
      <span className={styles.dot}>
        {look.dot === 'check' && <Check size={11} weight="bold" aria-hidden="true" />}
        {look.dot === 'cross' && <X size={10} weight="bold" aria-hidden="true" />}
        {look.dot === 'ring' && <span className={styles.ring} />}
        <span className="visually-hidden">{SPOKEN[look.dot]}: </span>
      </span>
      <div className={styles.box}>
        <div className={styles.title}>
          <span>{stage.title}</span>
          {stage.at && <span className={styles.time}>{stage.at}</span>}
        </div>
        {stage.count && (
          <div className={styles.count}>
            <span className={styles.countText}>
              <span className={styles.countFigure}>{count.format(stage.count.reached)}</span> of{' '}
              {count.format(stage.count.of)}
            </span>
            <StackedBar committed={stage.count.reached / stage.count.of} />
          </div>
        )}
        {stage.hash && (
          <div className={styles.hash}>
            <MonoValue value={stage.hash} full />
          </div>
        )}
        {stage.detail && <div className={styles.detail}>{stage.detail}</div>}
        {stage.links && stage.links.length > 0 && (
          <div className={styles.links}>
            {stage.links.map((link) => (
              <StageLinkView key={link.label} link={link} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function StageLinkView({ link }: { link: StageLink }) {
  if (link.href !== undefined) {
    return (
      <a className={styles.link} href={link.href} target="_blank" rel="noreferrer">
        {link.label} ›
      </a>
    );
  }
  return (
    <button type="button" className={styles.link} onClick={link.onSelect}>
      {link.label} ›
    </button>
  );
}
