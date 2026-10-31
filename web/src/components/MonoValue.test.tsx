import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MonoValue } from './MonoValue';

afterEach(cleanup);

const HASH = '0x7f3a9c21d84e6b0f5a13c7e92d48b6f01e5a7c3d9b2f4e816a0c5d7e3b9f2a41';

describe('MonoValue', () => {
  it('shows the head and tail of a long value around an ellipsis', () => {
    render(<MonoValue value={HASH} />);
    expect(screen.getByRole('button').textContent).toBe('0x7f3a…2a41');
  });

  it('honours a custom head and tail', () => {
    render(<MonoValue value={HASH} head={4} tail={3} />);
    expect(screen.getByRole('button').textContent).toBe('0x7f…a41');
  });

  it('shows a short value whole', () => {
    render(<MonoValue value="abc123" />);
    expect(screen.getByRole('button').textContent).toBe('abc123');
  });

  it('gives the full value on hover', () => {
    render(<MonoValue value={HASH} />);
    expect(screen.getByRole('button').getAttribute('title')).toBe(HASH);
  });

  it('copies the full value, not the truncated one, on click', async () => {
    const user = userEvent.setup();
    render(<MonoValue value={HASH} />);
    await user.click(screen.getByRole('button', { name: `Copy ${HASH}` }));
    expect(await navigator.clipboard.readText()).toBe(HASH);
    expect(screen.getByRole('button', { name: `Copied ${HASH}` })).toBeTruthy();
  });
});
