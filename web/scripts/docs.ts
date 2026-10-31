import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Element, ElementContent, Properties, Root, RootContent } from 'hast';
import { toHtml } from 'hast-util-to-html';
import { toString } from 'hast-util-to-string';
import MiniSearch from 'minisearch';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { createHighlighter, type Highlighter } from 'shiki';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Plugin } from 'vite';

import {
  type DocHeading,
  type DocPage,
  type DocsManifest,
  HTTP_METHODS,
  type HttpMethod,
  SEARCH_OPTIONS,
  type SearchEntry,
} from '../src/docs/manifest.ts';
import { EXCLUDED_DIRS, NAV, type NavSection, REPO_BLOB_URL } from '../src/docs/nav.ts';

export interface BuiltDocs {
  manifest: DocsManifest;
  searchIndex: string;
  // Absolute paths of every Markdown file read, for the dev server to watch.
  files: string[];
}

interface Planned {
  slug: string;
  source: string;
  section: string;
  title: string | undefined;
  label: string | undefined;
  adrNumber: string | undefined;
}

// A link to another page's anchor, checked once every page's ids are known.
interface AnchorCheck {
  from: string;
  href: string;
  target: string;
  anchor: string;
}

const LANGS = ['json', 'shellscript', 'javascript', 'typescript', 'yaml', 'sql', 'dotenv'];
const THEMES = { light: 'github-light', dark: 'github-dark' } as const;
const ADR_FILE = /^(\d{4})-.+\.md$/;
const METHOD_HEADING = new RegExp(`^(${HTTP_METHODS.join('|')})\\s+(/\\S*)$`);

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSlug);

/**
 * Renders the Markdown named in `nav` (paths from `root`, the repo root) into
 * the page manifest and a serialized search index. Throws, listing every
 * problem, on a broken internal link or anchor, a page with no title, or a
 * Markdown file under docs/ that the table leaves out.
 */
export async function buildDocs(root: string, nav: readonly NavSection[] = NAV): Promise<BuiltDocs> {
  const problems: string[] = [];
  const sections = plan(root, nav, problems);
  const planned = sections.flatMap((section) => section.pages);
  const bySource = new Map(planned.map((page) => [page.source, page]));

  const highlighter = await createHighlighter({ themes: Object.values(THEMES), langs: LANGS });
  const idsBySource = new Map<string, Set<string>>();
  const anchorChecks: AnchorCheck[] = [];
  const entries: SearchEntry[] = [];
  const pages = new Map<string, DocPage>();

  for (const page of planned) {
    const raw = readFileSync(path.join(root, page.source), 'utf8');
    const { body, status } = splitFrontmatter(raw);
    const tree = (await markdown.run(markdown.parse(body))) as Root;

    const title = page.title ?? takeTitle(tree);
    if (title === undefined) {
      problems.push(`${page.source}: no "# " title, and the nav table gives none`);
      continue;
    }
    removeTitle(tree);
    idsBySource.set(page.source, collectIds(tree));

    const headings = badgeHeadings(tree);
    entries.push(...searchEntries(tree, page.slug, title));
    rewriteLinks(tree, page, root, bySource, idsBySource, anchorChecks, problems);
    wrapCodeBlocks(tree, highlighter);
    groupTabs(tree);

    pages.set(page.source, {
      slug: page.slug,
      title,
      label: page.label ?? title,
      section: page.section,
      source: page.source,
      headings,
      html: toHtml(tree),
      ...(page.adrNumber !== undefined && {
        adr: { number: page.adrNumber, ...(status !== undefined && { status }) },
      }),
    });
  }

  for (const check of anchorChecks) {
    const ids = idsBySource.get(check.target) ?? (await idsOfFile(root, check.target));
    if (!ids.has(check.anchor)) {
      problems.push(`${check.from}: link "${check.href}" names no heading in ${check.target}`);
    }
  }
  highlighter.dispose();

  if (problems.length > 0) {
    throw new Error(`docs build failed:\n  ${problems.join('\n  ')}`);
  }

  const search = new MiniSearch<SearchEntry>(SEARCH_OPTIONS);
  search.addAll(entries);

  return {
    manifest: {
      sections: sections
        .filter((section) => section.pages.length > 0)
        .map((section) => ({
          title: section.title,
          pages: section.pages.map((page) => pages.get(page.source)!),
        })),
    },
    searchIndex: JSON.stringify(search),
    files: planned.map((page) => path.join(root, page.source)),
  };
}

function plan(root: string, nav: readonly NavSection[], problems: string[]) {
  const sections = nav.map((section) => {
    if (!('adrDirectory' in section.pages)) {
      return {
        title: section.title,
        pages: section.pages.map(
          (page): Planned => ({
            slug: page.slug ?? path.basename(page.source, '.md'),
            source: page.source,
            section: section.title,
            title: page.title,
            label: page.label,
            adrNumber: undefined,
          }),
        ),
      };
    }
    const directory = section.pages.adrDirectory;
    const adrs = readdirSync(path.join(root, directory))
      .flatMap((file) => {
        const number = ADR_FILE.exec(file)?.[1];
        return number === undefined ? [] : [{ file, number }];
      })
      .sort((a, b) => a.number.localeCompare(b.number));
    return {
      title: section.title,
      pages: adrs.map(
        ({ file, number }): Planned => ({
          slug: `adr/${number}`,
          source: `${directory}/${file}`,
          section: section.title,
          title: undefined,
          label: undefined,
          adrNumber: number,
        }),
      ),
    };
  });

  const sources = new Set(sections.flatMap((section) => section.pages.map((page) => page.source)));
  for (const source of sources) {
    if (!existsSync(path.join(root, source))) problems.push(`${source}: in the nav table but missing`);
  }
  for (const source of markdownUnder(root, 'docs')) {
    if (!sources.has(source)) {
      problems.push(`${source}: not in the nav table (web/src/docs/nav.ts) or EXCLUDED_DIRS`);
    }
  }
  const slugs = new Set<string>();
  for (const page of sections.flatMap((section) => section.pages)) {
    if (slugs.has(page.slug)) problems.push(`${page.source}: slug "${page.slug}" is taken`);
    slugs.add(page.slug);
  }
  return sections;
}

function markdownUnder(root: string, directory: string): string[] {
  if (EXCLUDED_DIRS.includes(directory) || !existsSync(path.join(root, directory))) return [];
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownUnder(root, child);
    return entry.name.endsWith('.md') ? [child] : [];
  });
}

function splitFrontmatter(raw: string): { body: string; status: string | undefined } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) return { body: raw, status: undefined };
  const status = /^status:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim();
  return { body: raw.slice(match[0].length), status };
}

function isElement(node: RootContent | ElementContent | undefined, tag?: string): node is Element {
  return node?.type === 'element' && (tag === undefined || node.tagName === tag);
}

function el(tagName: string, properties: Properties, children: ElementContent[]): Element {
  return { type: 'element', tagName, properties, children };
}

function text(value: string): ElementContent {
  return { type: 'text', value };
}

function takeTitle(tree: Root): string | undefined {
  const h1 = tree.children.find((node) => isElement(node, 'h1'));
  return h1 ? toString(h1) : undefined;
}

// The app renders the title itself, above the page.
function removeTitle(tree: Root): void {
  const index = tree.children.findIndex((node) => isElement(node, 'h1'));
  if (index !== -1) tree.children.splice(index, 1);
}

function collectIds(tree: Root): Set<string> {
  const ids = new Set<string>();
  visit(tree, 'element', (node) => {
    if (typeof node.properties.id === 'string') ids.add(node.properties.id);
  });
  return ids;
}

async function idsOfFile(root: string, source: string): Promise<Set<string>> {
  const raw = readFileSync(path.join(root, source), 'utf8');
  return collectIds((await markdown.run(markdown.parse(splitFrontmatter(raw).body))) as Root);
}

// An API route heading (`## POST /v1/dispatch`) gets a method badge styled
// like a status pill, and the path in code.
function badgeHeadings(tree: Root): DocHeading[] {
  const headings: DocHeading[] = [];
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'h2' && node.tagName !== 'h3') return;
    const id = String(node.properties.id);
    const content = toString(node).trim();
    const route = METHOD_HEADING.exec(content);
    if (!route) {
      headings.push({ id, depth: node.tagName === 'h2' ? 2 : 3, text: content });
      return;
    }
    const method = route[1] as HttpMethod;
    node.children = [
      el('span', { className: ['method'], dataMethod: method }, [text(method)]),
      text(' '),
      el('code', {}, [text(route[2]!)]),
    ];
    headings.push({ id, depth: node.tagName === 'h2' ? 2 : 3, text: content, method });
  });
  return headings;
}

function searchEntries(tree: Root, slug: string, pageTitle: string): SearchEntry[] {
  const entries: SearchEntry[] = [];
  let current = { anchor: '', heading: pageTitle, parts: [] as string[] };
  const flush = () => {
    const body = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (current.anchor === '' && body === '' && entries.length > 0) return;
    entries.push({
      id: `${slug}#${current.anchor}`,
      slug,
      anchor: current.anchor,
      pageTitle,
      heading: current.heading,
      text: body,
      excerpt: excerpt(body),
    });
  };
  for (const node of tree.children) {
    if (node.type !== 'element') continue;
    if (node.tagName === 'h2' || node.tagName === 'h3') {
      flush();
      current = { anchor: String(node.properties.id), heading: toString(node).trim(), parts: [] };
    } else {
      current.parts.push(toString(node));
    }
  }
  flush();
  return entries;
}

function excerpt(body: string): string {
  if (body.length <= 160) return body;
  const cut = body.slice(0, 160);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// Relative links between Markdown files become site routes; links to other
// repo files go to GitHub. Anything that resolves to nothing is a problem.
function rewriteLinks(
  tree: Root,
  page: Planned,
  root: string,
  bySource: Map<string, Planned>,
  idsBySource: Map<string, Set<string>>,
  anchorChecks: AnchorCheck[],
  problems: string[],
): void {
  const ownIds = idsBySource.get(page.source)!;
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'a' || typeof node.properties.href !== 'string') return;
    const href = node.properties.href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) return;

    const [file = '', rawAnchor] = href.split('#', 2);
    const anchor = rawAnchor === undefined ? undefined : decodeURIComponent(rawAnchor);
    if (file === '') {
      if (anchor !== undefined && !ownIds.has(anchor)) {
        problems.push(`${page.source}: link "${href}" names no heading on this page`);
      }
      return;
    }

    const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), file));
    if (target.startsWith('../') || !existsSync(path.join(root, target))) {
      problems.push(`${page.source}: link "${href}" points at ${target}, which does not exist`);
      return;
    }
    const hash = anchor === undefined ? '' : `#${anchor}`;
    const sitePage = bySource.get(target);
    node.properties.href = sitePage
      ? `/docs/${sitePage.slug}${hash}`
      : `${REPO_BLOB_URL}/${target}${hash}`;
    if (anchor !== undefined && target.endsWith('.md')) {
      anchorChecks.push({ from: page.source, href, target, anchor });
    }
  });
}

function wrapCodeBlocks(tree: Root, highlighter: Highlighter): void {
  visit(tree, 'element', (node, index, parent) => {
    const code = node.children[0];
    if (node.tagName !== 'pre' || !isElement(code, 'code') || !parent || index === undefined) return;

    const fence = String((code.properties.className as string[] | undefined)?.[0] ?? '');
    const lang = fence.replace(/^language-/, '') || 'text';
    const meta = (code.data as { meta?: string } | undefined)?.meta ?? '';
    const title = /\btitle="([^"]+)"/.exec(meta)?.[1];
    const source = toString(code).replace(/\n$/, '');
    const loaded = highlighter.getLoadedLanguages().includes(lang);
    const highlighted = highlighter.codeToHast(source, {
      lang: loaded ? lang : 'text',
      themes: THEMES,
      defaultColor: false,
    });
    const pre = highlighted.children[0] as Element;
    delete pre.properties.tabindex;

    parent.children[index] = el(
      'figure',
      { className: ['code'], ...(title !== undefined && { dataTitle: title }) },
      [
        el('figcaption', { className: ['code-bar'] }, [
          el('span', { className: ['code-lang'] }, [text(lang)]),
          el('button', { type: 'button', className: ['code-copy'], dataCopy: '' }, [text('Copy')]),
        ]),
        pre,
      ],
    );
    return 'skip';
  });
}

// Consecutive titled code blocks (```sh title="Solana", then ```sh
// title="Base") become one block with a tab per title.
function groupTabs(tree: Root): void {
  let group = 0;
  visit(tree, (node) => {
    if (!('children' in node)) return;
    const children = node.children as ElementContent[];
    const out: ElementContent[] = [];
    for (let i = 0; i < children.length; ) {
      const run: Element[] = [];
      let j = i;
      while (j < children.length) {
        const child = children[j];
        if (isElement(child, 'figure') && child.properties.dataTitle !== undefined) {
          run.push(child);
          j += 1;
        } else if (child?.type === 'text' && child.value.trim() === '' && run.length > 0) {
          j += 1;
        } else break;
      }
      if (run.length < 2) {
        out.push(children[i]!);
        i += 1;
        continue;
      }
      group += 1;
      out.push(tabs(run, `tabs-${group}`));
      i = j;
    }
    node.children = out as typeof node.children;
  });
}

function tabs(figures: Element[], id: string): Element {
  const titles = figures.map((figure) => String(figure.properties.dataTitle));
  return el('div', { className: ['code-tabs'] }, [
    el(
      'div',
      { role: 'tablist', ariaLabel: titles.join(' or ') },
      titles.map((title, i) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            id: `${id}-tab-${i}`,
            ariaSelected: i === 0 ? 'true' : 'false',
            ariaControls: [`${id}-panel-${i}`],
            tabIndex: i === 0 ? 0 : -1,
            dataTab: title,
          },
          [text(title)],
        ),
      ),
    ),
    ...figures.map((figure, i) => {
      // Without dataTitle the panels no longer look like a run to group.
      const { dataTitle: _title, ...properties } = figure.properties;
      figure.properties = {
        ...properties,
        role: 'tabpanel',
        id: `${id}-panel-${i}`,
        ariaLabelledby: [`${id}-tab-${i}`],
        hidden: i !== 0,
      };
      return figure;
    }),
  ]);
}

const MANIFEST_ID = 'virtual:docs';
const SEARCH_ID = 'virtual:docs-search';

/**
 * Serves `buildDocs` to the app as `virtual:docs` (the manifest) and
 * `virtual:docs-search` (the serialized index, loaded on first search).
 * A broken link fails `vite build`; in dev it shows in the error overlay, and
 * any Markdown edit rebuilds and reloads the page.
 */
export function docsPlugin(root: string): Plugin {
  let built: Promise<BuiltDocs> | undefined;
  const watched = [path.join(root, 'docs'), path.join(root, 'CONTEXT.md')];

  return {
    name: 'dispatch-docs',
    resolveId: (id) => (id === MANIFEST_ID || id === SEARCH_ID ? `\0${id}` : undefined),
    async load(id) {
      if (id !== `\0${MANIFEST_ID}` && id !== `\0${SEARCH_ID}`) return undefined;
      built ??= buildDocs(root);
      const docs = await built.catch((error: unknown) => {
        built = undefined;
        throw error;
      });
      for (const file of docs.files) this.addWatchFile(file);
      const value = id === `\0${MANIFEST_ID}` ? docs.manifest : docs.searchIndex;
      return `export default ${JSON.stringify(value)};`;
    },
    configureServer(server) {
      server.watcher.add(watched);
      server.watcher.on('all', (_event, file) => {
        if (!file.endsWith('.md') || !watched.some((dir) => file.startsWith(dir))) return;
        built = undefined;
        for (const id of [MANIFEST_ID, SEARCH_ID]) {
          const module = server.moduleGraph.getModuleById(`\0${id}`);
          if (module) server.moduleGraph.invalidateModule(module);
        }
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
