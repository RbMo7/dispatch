import type { Options } from 'minisearch';


export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface DocHeading {
  id: string;
  depth: 2 | 3;
  text: string;
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

export interface SearchEntry {
  id: string;
  slug: string;
  anchor: string;
  pageTitle: string;
  heading: string;
  text: string;
  excerpt: string;
}

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
