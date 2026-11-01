import { Card } from '../../components/Card';
import { Pill } from '../../components/StatusPill';
import {
  ago,
  AREA_LABEL,
  byArea,
  CHECK_STATUS,
  type Fix,
  type Setup,
  type SetupCheck,
  setupState,
  type SetupState,
} from '../../domain/setup';
import { describeFailure } from '../api/client';
import styles from '../console.module.css';
import { PageBar } from '../Shell';
import { useSetup } from './setupData';

/** Read-only: the checks `pnpm dispatch doctor` runs, as the engine last ran them. */
export function SetupPage() {
  const { data, error } = useSetup();
  return (
    <main className={styles.main}>
      <PageBar title="Setup" />
      <div className={styles.pageBody}>
        {data ? (
          <SetupView setup={data} now={new Date()} />
        ) : (
          <p className={styles.noRows}>
            {error ? describeFailure(error.failure) : 'Reading the setup checks'}
          </p>
        )}
      </div>
    </main>
  );
}

export function SetupView({ setup, now }: { setup: Setup; now: Date }) {
  const state = setupState(setup, now);
  return (
    <div className={styles.setup}>
      <SummaryCard setup={setup} state={state} now={now} />
      {byArea(setup.checks).map(({ area, checks }) => (
        <Card key={area} title={AREA_LABEL[area]}>
          <ul className={styles.checks}>
            {checks.map((check) => (
              <CheckRow key={check.id} check={check} now={now} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function headline(setup: Setup, state: SetupState): string {
  if (state.needsYou === 1) return '1 thing needs you';
  if (state.needsYou > 1) return `${state.needsYou} things need you`;
  return setup.worker.status === 'ran' ? 'All good' : 'Waiting for the worker';
}

function counts(state: SetupState): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `${state.passed} passed, ${plural(state.warnings.length, 'warning', 'warnings')}, ${plural(state.problems.length, 'problem', 'problems')}`;
}

function workerLine(setup: Setup, state: SetupState, now: Date): string {
  switch (setup.worker.status) {
    case 'not_run_yet':
      return 'The worker has not run its checks yet. It runs them when it starts and every five minutes after; until then only the database and console checks show here.';
    case 'unreadable':
      return "The worker's checks could not be read, because the database did not answer.";
    case 'ran':
      return state.workerStale
        ? `The worker last ran its checks ${ago(setup.worker.ranAt, now)}. It runs them every five minutes, so it may have stopped.`
        : `The worker last ran its checks ${ago(setup.worker.ranAt, now)} and runs them every five minutes. The database and console checks run when this page loads.`;
  }
}

function SummaryCard({ setup, state, now }: { setup: Setup; state: SetupState; now: Date }) {
  const attention = [...state.problems, ...state.warnings];
  return (
    <Card>
      <p className={styles.setupHeadline}>{headline(setup, state)}</p>
      <p className={styles.muted}>{counts(state)}</p>
      <p
        className={state.workerStale ? styles.setupWorkerStale : styles.setupWorker}
        role={state.workerStale ? 'alert' : undefined}
      >
        {workerLine(setup, state, now)}
      </p>
      {attention.length > 0 && (
        <ul className={styles.setupAttention}>
          {attention.map((check) => (
            <li key={check.id}>
              <a href={`#check-${check.id}`} className={styles.setupJump}>
                <Pill {...CHECK_STATUS[check.status]} />
                <span>
                  {AREA_LABEL[check.area]}, {check.title}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Capitalizes a leading plain word, never a path or a variable such as `web/dist/engine`. */
const sentence = (text: string) =>
  /^[a-z]+[\s,;:]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;

function FixText({ fix }: { fix: Fix }) {
  if ('command' in fix) {
    return (
      <>
        Run <code className={styles.code}>{fix.command}</code>
      </>
    );
  }
  if ('setting' in fix) {
    return (
      <>
        Set <code className={styles.code}>{fix.setting}</code> to {fix.value}
      </>
    );
  }
  return <>{sentence(fix.step)}</>;
}

function CheckRow({ check, now }: { check: SetupCheck; now: Date }) {
  return (
    <li className={styles.check} id={`check-${check.id}`}>
      <span className={styles.checkStatus}>
        <Pill {...CHECK_STATUS[check.status]} />
      </span>
      <div className={styles.checkBody}>
        <span className={styles.checkTitle}>{check.title}</span>
        <p className={styles.checkFinding}>{sentence(check.finding)}</p>
        {check.fix && (
          <p className={styles.checkFix}>
            <span className={styles.checkFixLabel}>Fix</span>
            <span>
              <FixText fix={check.fix} />
            </span>
          </p>
        )}
      </div>
      <span className={styles.checkWhen} title={check.ranAt.toLocaleString()}>
        {ago(check.ranAt, now)}, {check.ranIn === 'worker' ? 'worker' : 'API'}
      </span>
    </li>
  );
}
