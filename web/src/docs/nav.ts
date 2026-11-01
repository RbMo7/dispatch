export interface NavPage {
  source: string;
  slug?: string;
  title?: string;
  label?: string;
  /** Builds the page from this tag of the OpenAPI file in `source`, instead of from Markdown. */
  tag?: string;
}

export interface NavSection {
  title: string;
  pages: readonly NavPage[];
}

export const NAV: readonly NavSection[] = [
  {
    title: 'Get started',
    pages: [
      { source: 'docs/about.md', slug: 'about' },
      { source: 'docs/quickstart.md', slug: 'quickstart' },
      { source: 'docs/authentication.md', slug: 'authentication' },
      { source: 'docs/making-requests.md', slug: 'making-requests' },
      { source: 'docs/errors.md', slug: 'errors' },
      { source: 'docs/lifecycle.md', slug: 'lifecycle' },
      { source: 'docs/pagination.md', slug: 'pagination' },
      { source: 'docs/polling.md', slug: 'polling' },
    ],
  },
  {
    title: 'Guides',
    pages: [
      { source: 'docs/guides/send-payments.md', slug: 'guides/send-payments' },
      { source: 'docs/guides/call-a-contract.md', slug: 'guides/call-a-contract' },
      { source: 'docs/guides/relay.md', slug: 'guides/relay' },
      { source: 'docs/guides/bulk-call.md', slug: 'guides/bulk-call' },
      { source: 'docs/guides/multisig.md', slug: 'guides/multisig' },
      { source: 'docs/guides/cancel.md', slug: 'guides/cancel' },
      { source: 'docs/guides/flag-rules.md', slug: 'guides/flag-rules' },
      { source: 'docs/guides/track.md', slug: 'guides/track' },
      { source: 'docs/guides/sender-balances.md', slug: 'guides/sender-balances' },
      { source: 'docs/guides/console-export.md', slug: 'guides/console-export' },
    ],
  },
  {
    title: 'REST API reference',
    pages: [
      { source: 'docs/openapi.yaml', tag: 'Dispatches', slug: 'rest/dispatches' },
      { source: 'docs/openapi.yaml', tag: 'Flag Rules', slug: 'rest/flag-rules' },
      { source: 'docs/openapi.yaml', tag: 'Senders', slug: 'rest/senders' },
      { source: 'docs/openapi.yaml', tag: 'Setup', slug: 'rest/setup' },
      { source: 'docs/openapi.yaml', tag: 'Activity', slug: 'rest/activity' },
      { source: 'docs/openapi.yaml', tag: 'Health', slug: 'rest/health' },
    ],
  },
  {
    title: 'Self-hosting',
    pages: [
      { source: 'docs/self-hosting/install.md', slug: 'self-hosting/install' },
      { source: 'docs/self-hosting/configuration.md', slug: 'self-hosting/configuration' },
      { source: 'docs/self-hosting/signer.md', slug: 'self-hosting/signer' },
      { source: 'docs/self-hosting/multisig.md', slug: 'self-hosting/multisig' },
      { source: 'docs/self-hosting/console.md', slug: 'self-hosting/console' },
      { source: 'docs/self-hosting/troubleshooting.md', slug: 'self-hosting/troubleshooting' },
      { source: 'docs/self-hosting/mainnet.md', slug: 'self-hosting/mainnet' },
    ],
  },
];

/** Agent guidance and the decision records stay in the repo, off the site. */
export const EXCLUDED_DIRS: readonly string[] = ['docs/agents', 'docs/adr'];

export const REPO_BLOB_URL = 'https://github.com/RbMo7/dispatch/blob/main';
