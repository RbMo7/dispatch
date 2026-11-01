import { pass, warn, type Check } from '../check.js';

export const consoleBuilt: Check = {
  id: 'console.built',
  area: 'console',
  title: 'Built',
  // The worker never serves the console, so only the place that sees the API's files checks it.
  runsIn: ['cli'],
  scope: 'engine',
  run: ({ consoleBuilt }) =>
    consoleBuilt()
      ? pass('web/dist/engine is built, so the API serves the console at /console')
      : warn('web/dist/engine is missing, so the API serves no console', {
          command: 'pnpm --dir web install && pnpm --dir web build',
        }),
};
