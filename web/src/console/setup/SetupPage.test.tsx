import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Setup, SetupCheck } from '../../domain/setup';
import { SetupView } from './SetupPage';

afterEach(cleanup);

const NOW = new Date('2026-11-01T10:07:30.000Z');
const WORKER_RAN = new Date('2026-11-01T10:05:00.000Z');

function check(overrides: Partial<SetupCheck> & Pick<SetupCheck, 'id' | 'area' | 'title'>) {
  return {
    chain: null,
    ranIn: 'worker',
    ranAt: WORKER_RAN,
    status: 'pass',
    finding: 'fine',
    fix: null,
    ...overrides,
  } satisfies SetupCheck;
}

const migrated = check({
  id: 'database.migrated',
  area: 'database',
  title: 'Migrated',
  ranIn: 'api',
  ranAt: NOW,
  finding: 'every migration is applied',
});
const reachable = check({
  id: 'signer.reachable',
  area: 'signer',
  title: 'Reachable',
  finding: 'the Signer at SIGNER_URL (signer:8421) answered and accepted SIGNER_AUTH_TOKEN',
});
const fees = check({
  id: 'sender.fees:solana',
  area: 'sender',
  title: 'Fee balance (Solana)',
  chain: 'solana',
  finding: '2.1500 SOL covers the 0.0034 SOL paid in fees in the last 24 hours',
});

const signerDown: SetupCheck = {
  ...reachable,
  status: 'fail',
  finding: 'no Signer answered at SIGNER_URL (signer:8421)',
  fix: { command: 'docker compose up -d signer' },
};
const feesLow: SetupCheck = {
  ...fees,
  status: 'warn',
  finding: '0.0021 SOL covers less than the 0.0034 SOL paid in fees in the last 24 hours',
  fix: { step: 'send SOL to 3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe' },
};

const ran = { status: 'ran', ranAt: WORKER_RAN } as const;

function card(title: string) {
  return screen.getByRole('heading', { name: title }).closest('section')!;
}

describe('the Setup page', () => {
  it('says "All good" when every check passed, with one card per area in report order', () => {
    render(<SetupView setup={{ worker: ran, checks: [migrated, reachable, fees] }} now={NOW} />);

    expect(screen.getByText('All good')).toBeTruthy();
    expect(screen.getByText('3 passed, 0 warnings, 0 problems')).toBeTruthy();
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Database',
      'Signer',
      'Sender',
    ]);
    expect(within(card('Database')).getByText('just now, API')).toBeTruthy();
    expect(within(card('Signer')).getByText('2 min ago, worker')).toBeTruthy();
  });

  it('counts a problem and a warning as two things that need you, each row with its status in words and its fix', () => {
    const setup: Setup = { worker: ran, checks: [migrated, signerDown, feesLow] };

    render(<SetupView setup={setup} now={NOW} />);

    expect(screen.getByText('2 things need you')).toBeTruthy();
    expect(screen.getByText('1 passed, 1 warning, 1 problem')).toBeTruthy();
    const signer = within(card('Signer'));
    expect(signer.getByText('Problem')).toBeTruthy();
    expect(signer.getByText('No Signer answered at SIGNER_URL (signer:8421)')).toBeTruthy();
    expect(signer.getByText('docker compose up -d signer').closest('p')!.textContent).toBe(
      'FixRun docker compose up -d signer',
    );
    const sender = within(card('Sender'));
    expect(sender.getByText('Warning')).toBeTruthy();
    expect(
      sender.getByText('Send SOL to 3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe'),
    ).toBeTruthy();
  });

  it('on a fresh install, waits for the worker instead of saying all is good', () => {
    render(
      <SetupView setup={{ worker: { status: 'not_run_yet' }, checks: [migrated] }} now={NOW} />,
    );

    expect(screen.queryByText('All good')).toBeNull();
    expect(screen.getByText('Waiting for the worker')).toBeTruthy();
    expect(screen.getByText(/The worker has not run its checks yet/)).toBeTruthy();
  });

  it('counts a worker that has missed three runs as a thing that needs you', () => {
    const lastRun = new Date(NOW.getTime() - 47 * 60_000);

    render(
      <SetupView
        setup={{
          worker: { status: 'ran', ranAt: lastRun },
          checks: [{ ...reachable, ranAt: lastRun }],
        }}
        now={NOW}
      />,
    );

    expect(screen.getByText('1 thing needs you')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'The worker last ran its checks 47 min ago. It runs them every five minutes, so it may have stopped.',
    );
  });
});
