import type { Env } from '../config.js';
import type { Ui } from './init-ui.js';

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (
  command: string,
  args: readonly string[],
  options?: { env?: Env; cwd?: string },
) => Promise<RunResult>;

export type Service = 'postgres' | 'signer' | 'api' | 'worker';

/** How Compose reports one service's container (`docker compose ps --format json`). */
type ContainerState = { State?: string; Health?: string; ExitCode?: number };

/** What each service looks like once it is ready, beyond its container running. */
export type Readiness = {
  /** Compose's own state for the service, or undefined when it has no container. */
  container: (service: Service) => Promise<ContainerState | undefined>;
  /** Whether a published HTTP port answers at all. */
  answers: (url: string) => Promise<boolean>;
  logs: (service: Service, tail?: number) => Promise<string>;
};

const READY: Record<Service, (state: ContainerState, readiness: Readiness) => Promise<boolean>> = {
  postgres: (state) => Promise.resolve(state.Health === 'healthy'),
  signer: async (_, readiness) => readiness.answers('http://localhost:8421/'),
  api: async (_, readiness) => readiness.answers('http://localhost:8420/health'),
  worker: async (_, readiness) => (await readiness.logs('worker')).includes('"worker started"'),
};

export const LOG_LINES = 20;

export type StartOptions = {
  /** The engine uses its own database, not Compose's Postgres. */
  ownDatabase: boolean;
  /** For a `local` key: handed to Compose's signer service through the environment, never a file. */
  passphrase?: string;
  timeoutMs?: number;
  pollMs?: number;
};

export function composeCommands({ ownDatabase }: { ownDatabase: boolean }): string[][] {
  const noDeps = ownDatabase ? ['--no-deps'] : [];
  return [
    [
      'docker',
      'compose',
      'up',
      '-d',
      '--build',
      ...noDeps,
      ...(ownDatabase ? [] : ['postgres']),
      'signer',
    ],
    ['pnpm', 'db:migrate'],
    ['docker', 'compose', 'up', '-d', '--build', ...noDeps, 'api', 'worker'],
  ];
}

/**
 * Starts the Signer and the database, applies migrations, then starts the
 * API and the worker, waiting for each to be ready. Re-running it is safe:
 * Compose leaves a running, unchanged service alone. Returns false at the
 * first service that does not come up, after showing its last log lines.
 */
export async function startServices(
  run: Runner,
  readiness: Readiness,
  ui: Ui,
  root: string,
  options: StartOptions,
): Promise<boolean> {
  const env: Env = {
    ...process.env,
    ...(options.passphrase ? { SIGNER_KEYSTORE_PASSPHRASE: options.passphrase } : {}),
  };
  const [upFirst, migrate, upSecond] = composeCommands(options);
  const step = async (label: string, command: string[]) => {
    const progress = ui.progress(label);
    const result = await run(command[0]!, command.slice(1), { env, cwd: root });
    if (result.code === 0) {
      progress.done(label);
      return true;
    }
    progress.failed(`${command.join(' ')} exited ${result.code}`);
    ui.note('Its last lines', lastLines(`${result.stdout}\n${result.stderr}`));
    return false;
  };
  const waitFor = (service: Service) => waitForService(service, readiness, ui, options);

  if (!(await step('Building and starting the database and the Signer', upFirst!))) return false;
  if (!options.ownDatabase && !(await waitFor('postgres'))) return false;
  if (!(await step('Applying migrations', migrate!))) return false;
  if (!(await waitFor('signer'))) return false;
  if (!(await step('Building and starting the API and the worker', upSecond!))) return false;
  return (await waitFor('api')) && (await waitFor('worker'));
}

async function waitForService(
  service: Service,
  readiness: Readiness,
  ui: Ui,
  { timeoutMs = 120_000, pollMs = 1_000 }: StartOptions,
): Promise<boolean> {
  const progress = ui.progress(`Waiting for ${service}`);
  const started = Date.now();
  let why = `not ready after ${timeoutMs / 1000}s`;
  for (;;) {
    const state = await readiness.container(service);
    if (state?.State === 'exited' || state?.State === 'dead') {
      why = `its container stopped (exit code ${state.ExitCode ?? 'unknown'})`;
      break;
    }
    if (state?.State === 'running' && (await READY[service](state, readiness))) {
      progress.done(`${service} is ready (${Math.round((Date.now() - started) / 1000)}s)`);
      return true;
    }
    if (Date.now() - started >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  progress.failed(`${service}: ${why}`);
  ui.note(`${service}: its last ${LOG_LINES} log lines`, [
    ...lastLines(await readiness.logs(service, LOG_LINES)),
    '',
    `More: docker compose logs ${service}`,
  ]);
  return false;
}

function lastLines(text: string): string[] {
  return text.trimEnd().split('\n').slice(-LOG_LINES);
}

/** Compose prints one JSON object per line, or (before v2.21) one JSON array. */
export function parseComposePs(stdout: string): ContainerState | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  try {
    const parsed = JSON.parse(text) as ContainerState | ContainerState[];
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const [first] = text.split('\n');
    return first ? (JSON.parse(first) as ContainerState) : undefined;
  }
}

/** The real reads, through `docker compose` in `root` and HTTP on the published ports. */
export function composeReadiness(run: Runner, root: string): Readiness {
  return {
    container: async (service) => {
      const result = await run('docker', ['compose', 'ps', '--all', '--format', 'json', service], {
        cwd: root,
      });
      return result.code === 0 ? parseComposePs(result.stdout) : undefined;
    },
    answers: async (url) => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return true;
      } catch {
        return false;
      }
    },
    logs: async (service, tail) => {
      const result = await run(
        'docker',
        ['compose', 'logs', '--no-color', ...(tail ? ['--tail', String(tail)] : []), service],
        { cwd: root },
      );
      return `${result.stdout}${result.stderr}`;
    },
  };
}
