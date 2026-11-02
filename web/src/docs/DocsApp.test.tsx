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
  it('opens on About Dispatch, with the four sections GitHub-style docs have', () => {
    open('/docs');

    expect(title()).toBe('About Dispatch');
    const sections = sideNav()
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual(['Get started', 'Guides', 'REST API reference', 'Self-hosting']);
    expect(sideNav().queryByText(/^0046/)).toBeNull();
  });

  it('renders a reference page with each operation in the rail and an edit link to the spec', () => {
    open('/docs/rest/dispatches');

    expect(title()).toBe('Dispatches');
    const rail = within(screen.getByRole('navigation', { name: 'On this page' }));
    expect(rail.getByRole('link', { name: 'POST Create a Dispatch' })).toHaveProperty(
      'hash',
      '#create-a-dispatch',
    );
    expect(rail.getByRole('link', { name: 'GET List Dispatches' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit this page' })).toHaveProperty(
      'href',
      'https://github.com/RbMo7/dispatch/blob/main/docs/openapi.yaml',
    );
  });

  it('switches every sample on the page to the language you choose', async () => {
    const user = open('/docs/rest/dispatches');

    const [python] = screen.getAllByRole('tab', { name: 'Python' });
    await user.click(python!);

    for (const tab of screen.getAllByRole('tab', { name: 'Python' })) {
      expect(tab.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('shows the request and response of the example you pick', async () => {
    const user = open('/docs/rest/dispatches');

    const [menu] = screen.getAllByRole('combobox');
    await user.selectOptions(menu!, 'unknownAsset');

    const shown = document.querySelector<HTMLElement>(
      '[data-op="create-a-dispatch"]:not([hidden])',
    )!;
    expect(shown.dataset.example).toBe('unknownAsset');
    expect(shown.textContent).toContain('Status: 400');
    expect(shown.textContent).toContain('UNKNOWN_ASSET');
  });

  it('follows a link between Markdown files to its site route', async () => {
    const user = open('/docs/self-hosting/signer');

    const link = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === '/docs/self-hosting/mainnet')!;
    await user.click(link);

    expect(window.location.pathname).toBe('/docs/self-hosting/mainnet');
    expect(title()).toBe('Going to mainnet');
  });

  it('copies a code block', async () => {
    const user = open('/docs/making-requests');

    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0]!);

    expect(await navigator.clipboard.readText()).toMatch(/^export DISPATCH_URL=/);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('finds a heading with ⌘K and opens it from the keyboard', async () => {
    const user = open('/docs');

    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('many small proposals');
    const first = await screen.findAllByRole('option');
    expect(first[0]!.textContent).toContain('Many small Dispatches mean many small proposals');
    await user.keyboard('{Enter}');

    expect(window.location.pathname).toBe('/docs/self-hosting/multisig');
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
