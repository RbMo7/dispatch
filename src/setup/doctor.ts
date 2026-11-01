import type { Env } from '../config.js';
import { AREAS, type Area, type CheckContext } from './check.js';
import { CHECKS } from './checks.js';
import { AREA_NAMES, painter, renderHuman, renderJson, summarize, type Painter } from './report.js';
import { planChecks, runPlanned, type PlannedCheck } from './run.js';
import { errorText } from './wording.js';

export const EXIT = { ok: 0, problems: 1, cannotRun: 2 } as const;

export const DOCTOR_USAGE = `Usage: pnpm dispatch doctor [--json] [--only <area>]

Checks this engine's setup and prints what passed, what is missing, and how to fix it.
  --json          print the results as JSON
  --only <area>   run one area: ${AREAS.join(', ')}

Exits 0 when nothing failed, 1 when a check failed, 2 when doctor could not run.
`;

type Output = { write: (text: string) => unknown; isTTY?: boolean };

export type DoctorIo = {
  stdout: Output;
  stderr: Output;
  env: Env;
  makeContext: (env: Env) => { context: CheckContext; close: () => Promise<void> };
  timeoutMs?: number;
};

type Options = { json: boolean; only?: Area };

function parseArgs(args: readonly string[]): Options | string {
  const options: Options = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--only') {
      const area = args[++i];
      if (!AREAS.includes(area as Area)) {
        return `--only needs one of ${AREAS.join(', ')}${area ? `, not "${area}"` : ''}`;
      }
      options.only = area as Area;
    } else {
      return `unknown argument "${arg}"`;
    }
  }
  return options;
}

export async function doctor(args: readonly string[], io: DoctorIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(DOCTOR_USAGE);
    return EXIT.ok;
  }
  const options = parseArgs(args);
  if (typeof options === 'string') {
    io.stderr.write(`doctor: ${options}\n\n${DOCTOR_USAGE}`);
    return EXIT.cannotRun;
  }

  let built: ReturnType<DoctorIo['makeContext']>;
  try {
    built = io.makeContext(io.env);
  } catch (cause) {
    io.stderr.write(`doctor could not start: ${errorText(cause)}\n`);
    return EXIT.cannotRun;
  }

  try {
    const planned = planChecks(CHECKS, built.context, {
      place: 'cli',
      ...(options.only ? { only: options.only } : {}),
    });
    const interactive = !options.json && io.stdout.isTTY === true;
    const paint = painter(interactive && (io.env.NO_COLOR ?? '') === '');
    const spinner = interactive ? areaSpinner(io.stdout, planned, paint) : undefined;
    const outcomes = await runPlanned(planned, {
      ...(io.timeoutMs ? { timeoutMs: io.timeoutMs } : {}),
      ...(spinner ? { onSettled: (outcome) => spinner.settled(outcome.area) } : {}),
    });
    spinner?.stop();
    io.stdout.write(options.json ? renderJson(outcomes) : renderHuman(outcomes, paint));
    return summarize(outcomes).problems > 0 ? EXIT.problems : EXIT.ok;
  } catch (cause) {
    io.stderr.write(`doctor could not finish: ${errorText(cause)}\n`);
    return EXIT.cannotRun;
  } finally {
    await built.close().catch(() => {});
  }
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** One line per area, spinning until its last check settles; erased before the report prints. */
function areaSpinner(out: Output, planned: readonly PlannedCheck[], paint: Painter) {
  const remaining = new Map<Area, number>();
  for (const { area } of planned) remaining.set(area, (remaining.get(area) ?? 0) + 1);
  const areas = [...remaining.keys()];
  let frame = 0;
  let drawn = false;

  const draw = () => {
    if (drawn) out.write(`\x1b[${areas.length}A`);
    for (const area of areas) {
      const done = remaining.get(area) === 0;
      const mark = done ? paint('dim', '·') : FRAMES[frame % FRAMES.length]!;
      out.write(`\x1b[2K${mark} ${AREA_NAMES[area]}${done ? paint('dim', ' done') : ''}\n`);
    }
    drawn = true;
    frame++;
  };
  draw();
  const timer = setInterval(draw, 80);

  return {
    settled: (area: Area) => remaining.set(area, (remaining.get(area) ?? 1) - 1),
    stop: () => {
      clearInterval(timer);
      out.write(`\x1b[${areas.length}A\x1b[0J`);
    },
  };
}
