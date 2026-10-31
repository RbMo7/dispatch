// The one table from the docs site's sections to the Markdown that fills them.
// Paths are from the repo root. A section with no pages is left out of the
// site until a file is added here. scripts/docs.ts fails the build if a
// Markdown file under docs/ is in neither this table nor EXCLUDED_DIRS.

export interface NavPage {
  source: string;
  // Defaults: the file name without `.md`, and the page's `# ` heading.
  slug?: string;
  title?: string;
  // A shorter name for the left navigation, when the title is a sentence.
  label?: string;
}

export interface NavSection {
  title: string;
  // `adrDirectory`: every `NNNN-*.md` in it, in number order, at `adr/NNNN`.
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

// Internal agent guidance, not for readers of the site.
export const EXCLUDED_DIRS: readonly string[] = ['docs/agents'];

export const REPO_BLOB_URL = 'https://github.com/RbMo7/dispatch/blob/main';
