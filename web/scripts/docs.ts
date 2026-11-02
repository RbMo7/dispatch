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
import { type ApiSpec, loadOpenApi } from './openapi.ts';
import { referenceTree, type Renderers } from './reference.ts';

export interface BuiltDocs {
  manifest: DocsManifest;
  searchIndex: string;
  files: string[];
}

interface Planned {
  slug: string;
  source: string;
  section: string;
  title: string | undefined;
  label: string | undefined;
  /** Set for a reference page, built from this OpenAPI tag in `source` instead of Markdown. */
  tag: string | undefined;
}

interface AnchorCheck {
  from: string;
  href: string;
  target: string;
  anchor: string;
}

const LANGS = [
  'json',
  'shellscript',
  'javascript',
  'typescript',
  'python',
  'jsonc',
  'yaml',
  'sql',
  'dotenv',
];
const LANG_LABELS: Record<string, string> = {
  shellscript: 'sh',
  javascript: 'js',
  python: 'py',
  jsonc: 'json',
};
const THEMES = { light: 'github-light', dark: 'github-dark' } as const;
const METHOD_HEADING = new RegExp(`^(${HTTP_METHODS.join('|')})\\s+(/\\S*)$`);

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSlug);

/**
 * Renders the pages named in `nav` (paths from `root`, the repo root) into the page manifest and
 * a serialized search index: Markdown files, and reference pages built from an OpenAPI tag.
 * Throws, listing every problem, on a broken internal link or anchor, a page with no title, or a
 * Markdown file under docs/ that the table leaves out.
 */
export async function buildDocs(
  root: string,
  nav: readonly NavSection[] = NAV,
): Promise<BuiltDocs> {
  const problems: string[] = [];
  const sections = plan(root, nav, problems);
  const planned = sections.flatMap((section) => section.pages);
  const bySource = new Map(
    planned.filter((page) => page.tag === undefined).map((page) => [page.source, page]),
  );

  const highlighter = await createHighlighter({ themes: Object.values(THEMES), langs: LANGS });
  const idsBySlug = new Map<string, Set<string>>();
  const anchorChecks: AnchorCheck[] = [];
  const entries: SearchEntry[] = [];
  const pages = new Map<string, DocPage>();
  const renderers: Renderers = {
    markdown: (source) => {
      const tree = markdown.runSync(markdown.parse(source));
      wrapCodeBlocks(tree, highlighter);
      return tree.children as ElementContent[];
    },
    code: (source, lang, title) => codeFigure(highlighter, source, lang, title),
    tabs,
  };

  // Reference pages are built first, so a Markdown link to an operation can find its page.
  const specs = new Map<string, ApiSpec>();
  const referenceTrees = new Map<string, { tree: Root; title: string; headings: DocHeading[] }>();
  const operationPages = new Map<string, Map<string, string>>();
  for (const page of planned.filter((p) => p.tag !== undefined)) {
    if (!specs.has(page.source)) {
      problems.push(
        ...proseProblems(page.source, readFileSync(path.join(root, page.source), 'utf8')),
      );
    }
    const spec = specs.get(page.source) ?? loadOpenApi(root, page.source);
    specs.set(page.source, spec);
    const tag = spec.tags.find((t) => t.name === page.tag);
    if (!tag) {
      problems.push(`${page.source}: no tag "${page.tag}" for ${page.slug}`);
      continue;
    }
    const { tree, headings } = referenceTree(tag, spec, renderers);
    const ids = collectIds(tree);
    idsBySlug.set(page.slug, ids);
    const anchors = operationPages.get(page.source) ?? new Map<string, string>();
    for (const id of ids) anchors.set(id, page.slug);
    operationPages.set(page.source, anchors);
    referenceTrees.set(page.slug, { tree, title: page.title ?? tag.name, headings });
  }

  for (const page of planned) {
    const reference = referenceTrees.get(page.slug);
    let tree: Root;
    let title: string;
    let headings: DocHeading[];
    if (page.tag !== undefined) {
      if (!reference) continue;
      ({ tree, title, headings } = reference);
    } else {
      const raw = readFileSync(path.join(root, page.source), 'utf8');
      problems.push(...proseProblems(page.source, raw));
      tree = await markdown.run(markdown.parse(raw));
      const found = page.title ?? takeTitle(tree);
      if (found === undefined) {
        problems.push(`${page.source}: no "# " title, and the nav table gives none`);
        continue;
      }
      title = found;
      removeTitle(tree);
      idsBySlug.set(page.slug, collectIds(tree));
      headings = badgeHeadings(tree);
      inlineDiagrams(tree, page, root, problems);
    }

    entries.push(...searchEntries(tree, page.slug, title));
    rewriteLinks(tree, page, root, bySource, idsBySlug, operationPages, anchorChecks, problems);
    if (page.tag === undefined) {
      wrapCodeBlocks(tree, highlighter);
      groupTabs(tree);
    }

    pages.set(page.slug, {
      slug: page.slug,
      title,
      label: page.label ?? title,
      section: page.section,
      source: page.source,
      headings,
      html: toHtml(tree, { allowDangerousHtml: true }),
      ...(page.tag !== undefined && { layout: 'reference' as const }),
    });
  }

  const slugBySource = new Map([...bySource].map(([source, page]) => [source, page.slug]));
  for (const check of anchorChecks) {
    const slug = slugBySource.get(check.target);
    const ids =
      (slug === undefined ? undefined : idsBySlug.get(slug)) ??
      (await idsOfFile(root, check.target));
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
          pages: section.pages.flatMap((page) => pages.get(page.slug) ?? []),
        })),
    },
    searchIndex: JSON.stringify(search),
    files: [...new Set(planned.map((page) => path.join(root, page.source)))],
  };
}

/**
 * The docs' house rules that a reader would notice: no em or en dashes, no decision-record
 * numbers (the records stay in the repo, off the site), and none of the filler words that say
 * nothing. Code is exempt, so a quoted log line or a real identifier can say what it says.
 */
const PROSE_RULES: [RegExp, string][] = [
  [/[–—]/, 'an en or em dash'],
  [/\bADR-\d{4}\b/, 'an ADR number'],
  [/\b(simply|just|seamless(ly)?|robust)\b/i, 'a filler word'],
];

function proseProblems(source: string, raw: string): string[] {
  const prose = raw
    .replace(/^([ \t]*)(`{3,})[\s\S]*?^\1\2/gm, (block) => block.replace(/[^\n]/g, ''))
    .replace(/`[^`\n]*`/g, '');
  return prose.split('\n').flatMap((line, i) =>
    PROSE_RULES.flatMap(([rule, what]) => {
      const found = rule.exec(line)?.[0];
      return found ? [`${source}: line ${i + 1} has ${what}: "${found}"`] : [];
    }),
  );
}

function plan(root: string, nav: readonly NavSection[], problems: string[]) {
  const sections = nav.map((section) => ({
    title: section.title,
    pages: section.pages.map((page): Planned => ({
      slug: page.slug ?? path.basename(page.source, '.md'),
      source: page.source,
      section: section.title,
      title: page.title,
      label: page.label,
      tag: page.tag,
    })),
  }));

  const sources = new Set(sections.flatMap((section) => section.pages.map((page) => page.source)));
  for (const source of sources) {
    if (!existsSync(path.join(root, source)))
      problems.push(`${source}: in the nav table but missing`);
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
  return collectIds(await markdown.run(markdown.parse(raw)));
}

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
      current.parts.push(searchText(node));
    }
  }
  flush();
  return entries;
}

/** A node's text for search, leaving out the reference pages' request and response samples. */
function searchText(node: ElementContent | RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element' || node.properties.dataSearch === 'skip') return '';
  return node.children.map(searchText).join(' ');
}

function excerpt(body: string): string {
  if (body.length <= 160) return body;
  const cut = body.slice(0, 160);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

function rewriteLinks(
  tree: Root,
  page: Planned,
  root: string,
  bySource: Map<string, Planned>,
  idsBySlug: Map<string, Set<string>>,
  operationPages: Map<string, Map<string, string>>,
  anchorChecks: AnchorCheck[],
  problems: string[],
): void {
  const ownIds = idsBySlug.get(page.slug)!;
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
    const operations = operationPages.get(target);
    if (operations) {
      const slug = anchor === undefined ? undefined : operations.get(anchor);
      if (slug === undefined) problems.push(`${page.source}: link "${href}" names no operation`);
      else node.properties.href = `/docs/${slug}${hash}`;
      return;
    }
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
    if (node.tagName !== 'pre' || !isElement(code, 'code') || !parent || index === undefined)
      return;

    const fence = String(code.properties.className?.[0] ?? '');
    const lang = fence.replace(/^language-/, '') || 'text';
    const meta = (code.data as { meta?: string } | undefined)?.meta ?? '';
    const title = /\btitle="([^"]+)"/.exec(meta)?.[1];
    parent.children[index] = codeFigure(
      highlighter,
      toString(code).replace(/\n$/, ''),
      lang,
      title,
    );
    return 'skip';
  });
}

function codeFigure(
  highlighter: Highlighter,
  source: string,
  lang: string,
  title?: string,
): Element {
  const loaded = highlighter.getLoadedLanguages().includes(lang);
  const highlighted = highlighter.codeToHast(source, {
    lang: loaded ? lang : 'text',
    themes: THEMES,
    defaultColor: false,
  });
  const pre = highlighted.children[0] as Element;
  delete pre.properties.tabindex;
  return el('figure', { className: ['code'], ...(title !== undefined && { dataTitle: title }) }, [
    el('figcaption', { className: ['code-bar'] }, [
      el('span', { className: ['code-lang'] }, [text(LANG_LABELS[lang] ?? lang)]),
      el('button', { type: 'button', className: ['code-copy'], dataCopy: '' }, [text('Copy')]),
    ]),
    pre,
  ]);
}

/**
 * A Markdown image of an `.svg` in the repo is inlined, so the diagram draws with the page's own
 * colours in either theme. Its alt text becomes the caption.
 */
function inlineDiagrams(tree: Root, page: Planned, root: string, problems: string[]): void {
  visit(tree, 'element', (node, index, parent) => {
    if (node.tagName !== 'img' || !parent || index === undefined) return;
    const src = String(node.properties.src ?? '');
    if (!src.endsWith('.svg') || /^[a-z]+:/i.test(src)) return;
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), src));
    if (!existsSync(path.join(root, file))) {
      problems.push(`${page.source}: image "${src}" points at ${file}, which does not exist`);
      return;
    }
    const svg = readFileSync(path.join(root, file), 'utf8').replace(/^<\?xml[^>]*>\s*/, '');
    const alt = String(node.properties.alt ?? '');
    const raw = { type: 'raw', value: svg } as unknown as ElementContent;
    // A lone image sits in its own paragraph; the figure takes the paragraph's place.
    const host = parent.type === 'element' && parent.tagName === 'p' ? parent : undefined;
    const figure = el('figure', { className: ['diagram'] }, [
      raw,
      ...(alt ? [el('figcaption', {}, [text(alt)])] : []),
    ]);
    if (host && host.children.length === 1) {
      host.tagName = 'div';
      host.properties = { className: ['diagram-host'] };
    }
    parent.children[index] = figure;
  });
}

function groupTabs(tree: Root): void {
  let group = 0;
  visit(tree, (node) => {
    if (!('children' in node)) return;
    const children = node.children as ElementContent[];
    const out: ElementContent[] = [];
    for (let i = 0; i < children.length;) {
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
    node.children = out;
  });
}

/** Panels, each with a `dataTitle`, become one block with a tab per title. */
function tabs(panels: Element[], id: string): Element {
  const titles = panels.map((panel) => String(panel.properties.dataTitle));
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
    ...panels.map((panel, i) => {
      const properties = { ...panel.properties };
      delete properties.dataTitle;
      panel.properties = {
        ...properties,
        role: 'tabpanel',
        id: `${id}-panel-${i}`,
        ariaLabelledby: [`${id}-tab-${i}`],
        hidden: i !== 0,
      };
      return panel;
    }),
  ]);
}

const MANIFEST_ID = 'virtual:docs';
const SEARCH_ID = 'virtual:docs-search';

/**
 * Serves `buildDocs` to the app as `virtual:docs` (the manifest) and
 * `virtual:docs-search` (the serialized index, loaded on first search).
 * A broken link fails `vite build`; in dev it shows in the error overlay, and
 * any Markdown or OpenAPI edit rebuilds and reloads the page.
 */
export function docsPlugin(root: string): Plugin {
  let built: Promise<BuiltDocs> | undefined;
  const watched = [path.join(root, 'docs')];

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
        if (!/\.(md|ya?ml|svg)$/.test(file) || !watched.some((dir) => file.startsWith(dir))) return;
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
