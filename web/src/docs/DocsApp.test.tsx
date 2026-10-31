import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DocsApp } from './DocsApp';

beforeAll(() => {
  // jsdom does no layout, so it has neither.
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
});

afterEach(cleanup);

function open(path: string) {
  window.history.pushState(null, '', path);
  const user = userEvent.setup();
  render(<DocsApp />);
  return user;
}

const title = () => screen.getByRole('heading', { level: 1 }).textContent;
const sideNav = () => within(screen.getByRole('navigation', { name: 'Docs' }));

describe('the docs site', () => {
  it('shows the first page in nav order at /docs, and only sections that have pages', () => {
    open('/docs');

    expect(title()).toBe('What Dispatch is');
    const sections = sideNav()
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual([
      'Get started',
      'Concepts',
      'API reference',
      'Guides',
      'Operations',
      'Decisions',
    ]);
  });

  it('renders a page with its method badges in the rail and an edit link to its source', () => {
    open('/docs/api/create-dispatch');

    expect(title()).toBe('Create a Dispatch');
    const rail = within(screen.getByRole('navigation', { name: 'On this page' }));
    expect(rail.getByRole('link', { name: 'POST /v1/dispatch' })).toHaveProperty(
      'hash',
      '#post-v1dispatch',
    );
    expect(screen.getByRole('link', { name: 'Edit this page' })).toHaveProperty(
      'href',
      'https://github.com/RbMo7/dispatch/blob/main/docs/api/create-dispatch.md',
    );
  });

  it('lists the decisions by number and opens one', async () => {
    const user = open('/docs');

    await user.click(sideNav().getByRole('link', { name: /^0046/ }));

    expect(window.location.pathname).toBe('/docs/adr/0046');
    expect(screen.getByText('ADR-0046')).toBeTruthy();
    expect(title()).toMatch(/^The Signer sees the whole transaction/);
  });

  it('follows a link between Markdown files to its site route', async () => {
    const user = open('/docs/multisig');

    const link = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/docs/operations/mainnet-checklist')!;
    await user.click(link);

    expect(window.location.pathname).toBe('/docs/operations/mainnet-checklist');
    expect(title()).toBe('Mainnet checklist');
  });

  it('copies a code block', async () => {
    const user = open('/docs/api/create-dispatch');

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[1]!);

    expect(await navigator.clipboard.readText()).toMatch(/^\{ "dispatchId": /);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('finds a heading with ⌘K and opens it from the keyboard', async () => {
    const user = open('/docs');

    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('many small proposals');
    const first = await screen.findAllByRole('option');
    expect(first[0]!.textContent).toContain('Many small Dispatches mean many small proposals');
    await user.keyboard('{Enter}');

    expect(window.location.pathname).toBe('/docs/multisig');
    expect(window.location.hash).toBe('#many-small-dispatches-mean-many-small-proposals');
  });

  it('shows a not-found page that searches for the missing slug', async () => {
    const user = open('/docs/fee-bumps');

    expect(screen.getByText(/No page at \/docs\/fee-bumps/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Search the docs' }));

    const input = await screen.findByRole('combobox');
    expect(input).toHaveProperty('value', 'fee bumps');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
  });
});
