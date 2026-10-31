import manifest from 'virtual:docs';

import type { DocPage } from './manifest';

export const SECTIONS = manifest.sections;
export const PAGES: readonly DocPage[] = SECTIONS.flatMap((section) => section.pages);

const BY_SLUG = new Map(PAGES.map((page) => [page.slug, page]));

export function pageForPath(pathname: string): DocPage | undefined {
  const slug = pathname.replace(/^\/docs\/?/, '').replace(/\/+$/, '');
  return slug === '' ? PAGES[0] : BY_SLUG.get(slug);
}

export function hrefFor(page: DocPage, anchor = ''): string {
  return `/docs/${page.slug}${anchor === '' ? '' : `#${anchor}`}`;
}
