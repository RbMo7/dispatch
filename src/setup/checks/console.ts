import { pass, warn, type Check } from '../check.js';

export const consoleBuilt: Check = {
  id: 'console.built',
  area: 'console',
  title: 'Built',
  // The worker never serves the console, so only the places that see the API's files check it.
  runsIn: ['cli', 'api'],
  scope: 'engine',
  run: ({ consoleBuilt }) =>
    consoleBuilt()
      ? pass('web/dist/engine is built, so the API serves the console at /console')
      : warn('web/dist/engine is missing, so the API serves no console', {
          command: 'pnpm --dir web install && pnpm --dir web build',
        }),
};
