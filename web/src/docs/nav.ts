export interface NavPage {
  source: string;
  slug?: string;
  title?: string;
  label?: string;
}

export interface NavSection {
  title: string;
  pages: readonly NavPage[] | { adrDirectory: string };
}

export const NAV: readonly NavSection[] = [
  {
    title: 'Get started',
    pages: [
      { source: 'docs/concept.md', slug: 'introduction', label: 'What Dispatch is' },
      { source: 'docs/quickstart.md', slug: 'quickstart' },
      { source: 'docs/first-dispatch.md', slug: 'first-dispatch', label: 'Your first Dispatch' },
    ],
  },
  {
    title: 'Concepts',
    pages: [
      { source: 'docs/concepts/managed-and-relay.md', slug: 'concepts/managed-and-relay' },
      { source: 'docs/concepts/senders-and-signers.md', slug: 'concepts/senders-and-signers' },
      { source: 'docs/concepts/calls-and-payments.md', slug: 'concepts/calls-and-payments' },
      { source: 'docs/concepts/statuses.md', slug: 'concepts/statuses' },
      { source: 'docs/concepts/funding-check.md', slug: 'concepts/funding-check' },
      { source: 'docs/concepts/retry-policy.md', slug: 'concepts/retry-policy' },
      { source: 'docs/concepts/multisig-and-treasury.md', slug: 'concepts/multisig-and-treasury' },
      { source: 'docs/concepts/proposals.md', slug: 'concepts/proposals' },
      { source: 'CONTEXT.md', slug: 'glossary', title: 'Glossary' },
    ],
  },
  {
    title: 'API reference',
    pages: [
      { source: 'docs/api.md', slug: 'api', label: 'Overview and errors' },
      { source: 'docs/api/create-dispatch.md', slug: 'api/create-dispatch' },
      { source: 'docs/api/get-dispatch.md', slug: 'api/get-dispatch' },
      { source: 'docs/api/list-dispatches.md', slug: 'api/list-dispatches' },
      { source: 'docs/api/cancel-dispatch.md', slug: 'api/cancel-dispatch' },
      { source: 'docs/api/senders.md', slug: 'api/senders' },
    ],
  },
  {
    title: 'Guides',
    pages: [
      { source: 'docs/signer.md', slug: 'signer', label: 'Set up the Signer' },
      { source: 'docs/multisig.md', slug: 'multisig', label: 'Multisig' },
      { source: 'docs/guides/squads.md', slug: 'guides/squads' },
      { source: 'docs/guides/safe.md', slug: 'guides/safe' },
      { source: 'docs/guides/relay-dispatch.md', slug: 'guides/relay-dispatch', label: 'Relay Dispatch' },
      { source: 'docs/guides/bulk-call.md', slug: 'guides/bulk-call', label: 'Bulk Call' },
      { source: 'docs/guides/console.md', slug: 'guides/console', label: 'Web console' },
    ],
  },
  {
    title: 'Operations',
    pages: [
      { source: 'docs/operations/configuration.md', slug: 'operations/configuration' },
      { source: 'docs/operations/troubleshooting.md', slug: 'operations/troubleshooting' },
      { source: 'docs/operations/mainnet-checklist.md', slug: 'operations/mainnet-checklist' },
    ],
  },
  { title: 'Decisions', pages: { adrDirectory: 'docs/adr' } },
];

export const EXCLUDED_DIRS: readonly string[] = ['docs/agents'];

export const REPO_BLOB_URL = 'https://github.com/RbMo7/dispatch/blob/main';
