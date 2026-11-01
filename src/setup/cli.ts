// Loads .env into process.env, as the API and the worker do.
import '../config.js';
import { cliContext } from './cli-context.js';
import { doctor, EXIT } from './doctor.js';

const USAGE = `Usage: pnpm dispatch <command>

Commands:
  doctor   check this engine's setup (pnpm dispatch doctor --help)
`;

const [command, ...args] = process.argv.slice(2);

let code: number;
if (command === 'doctor') {
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
