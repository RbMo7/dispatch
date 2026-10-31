import type { Options } from 'minisearch';

// What scripts/docs.ts produces at build time and the docs app imports from
// `virtual:docs`. The HTML is final: highlighted, links rewritten to site
// routes, code blocks wrapped with their label, copy button and tabs.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface DocHeading {
  id: string;
  depth: 2 | 3;
  text: string;
  // Set for an API route heading such as `POST /v1/dispatch`.
  method?: HttpMethod;
}

export interface DocPage {
  slug: string;
  title: string;
  label: string;
  section: string;
  source: string;
  headings: DocHeading[];
  html: string;
  adr?: { number: string; status?: string };
}

export interface DocsManifest {
  sections: { title: string; pages: DocPage[] }[];
}

// One searchable unit: a page's intro, or the text under one heading.
export interface SearchEntry {
  id: string;
  slug: string;
  anchor: string;
  pageTitle: string;
  heading: string;
  text: string;
  excerpt: string;
}

// Shared by the build that writes the index and the app that loads it:
// MiniSearch needs the same options on both sides.
export const SEARCH_OPTIONS: Options<SearchEntry> = {
  fields: ['heading', 'pageTitle', 'text'],
  storeFields: ['slug', 'anchor', 'pageTitle', 'heading', 'excerpt'],
  searchOptions: {
    boost: { heading: 3, pageTitle: 2 },
    prefix: true,
    fuzzy: 0.2,
    combineWith: 'AND',
  },
};
