import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Status } from '../domain/status';
import { StatusPill } from './StatusPill';

afterEach(cleanup);

const EXPECTED: Record<Status, string> = {
  queued: 'Queued',
  broadcasting: 'Broadcasting',
  awaiting_approval: 'Awaiting approval',
  held: 'Held',
  confirmed: 'Confirmed',
  partial: 'Partial',
  failed: 'Failed',
  abandoned: 'Abandoned',
  cancelled: 'Cancelled',
};

describe('StatusPill', () => {
  it.each(Object.entries(EXPECTED) as [Status, string][])(
    '%s says "%s" in words, with nothing else in the pill',
    (status, label) => {
      const { container } = render(<StatusPill status={status} />);
      expect(container.textContent).toBe(label);
      expect(container.querySelector('svg, [aria-hidden="true"]')).toBeNull();
    },
  );

  it('changes its words when the status changes', () => {
    const { container, rerender } = render(<StatusPill status="broadcasting" />);
    rerender(<StatusPill status="confirmed" />);
    expect(container.textContent).toContain('Confirmed');
  });
});
