// Loads .env into process.env, as the API and the worker do.
import '../config.js';
import { cliContext } from './cli-context.js';
import { doctor, EXIT } from './doctor.js';
import { init } from './init.js';
import { processInitIo } from './init-io.js';

const USAGE = `Usage: pnpm dispatch <command>

Commands:
  init     set up this engine: chains, keys, .env and services (pnpm dispatch init --help)
  doctor   check this engine's setup (pnpm dispatch doctor --help)
`;

const [command, ...args] = process.argv.slice(2);

let code: number;
if (command === 'init') {
  code = await init(args, processInitIo());
} else if (command === 'doctor') {
  code = await doctor(args, {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    makeContext: cliContext,
  });
} else if (command === '--help' || command === '-h') {
  process.stdout.write(USAGE);
  code = EXIT.ok;
} else {
  process.stderr.write(
    `${command === undefined ? '' : `unknown command "${command}"\n\n`}${USAGE}`,
  );
  code = EXIT.cannotRun;
}
process.exit(code);
