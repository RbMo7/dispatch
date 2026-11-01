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
  { title: 'Get started', pages: [] },
  {
    title: 'Concepts',
    pages: [
      { source: 'docs/concept.md', label: 'What Dispatch is' },
      { source: 'CONTEXT.md', slug: 'glossary', title: 'Glossary' },
    ],
  },
  { title: 'API reference', pages: [{ source: 'docs/api.md', label: 'HTTP API' }] },
  {
    title: 'Guides',
    pages: [
      { source: 'docs/signer.md', label: 'Production Signer' },
      { source: 'docs/multisig.md', label: 'Treasury and Multisig Sender' },
    ],
  },
  { title: 'Operations', pages: [] },
  { title: 'Decisions', pages: { adrDirectory: 'docs/adr' } },
];

export const EXCLUDED_DIRS: readonly string[] = ['docs/agents'];

export const REPO_BLOB_URL = 'https://github.com/RbMo7/dispatch/blob/main';
