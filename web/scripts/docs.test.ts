// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { NavSection } from '../src/docs/nav.ts';
import { buildDocs } from './docs.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const NAV: NavSection[] = [
  { title: 'Get started', pages: [] },
  { title: 'Guides', pages: [{ source: 'docs/a.md' }, { source: 'docs/b.md', label: 'Bee' }] },
  { title: 'Decisions', pages: { adrDirectory: 'docs/adr' } },
];

let fixture: string | undefined;

function repo(files: Record<string, string>): string {
  fixture = mkdtempSync(path.join(tmpdir(), 'docs-build-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    writeFileSync(path.join(fixture, file), content);
  }
  return fixture;
}

const VALID = {
  'docs/a.md': [
    '# Page A',
    '',
    'See [B](./b.md#hello), [the source](../src/x.ts) and [here](#post-v1x).',
    '',
    '## POST /v1/x',
    '',
    '```sh title="Solana"',
    'echo solana',
    '```',
    '',
    '```sh title="Base"',
    'echo base',
    '```',
  ].join('\n'),
  'docs/b.md': '# Page B\n\n## Hello\n\nThe word zebra lives here.\n',
  'docs/adr/0002-second.md': '# Second decision\n',
  'docs/adr/0001-first.md': '---\nstatus: superseded by ADR-0002\n---\n\n# First decision\n',
  'docs/agents/internal.md': '# Not for the site\n',
  'src/x.ts': 'export {};\n',
};

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe('buildDocs', () => {
  it('renders every Markdown file under docs/, except agent guidance, with no broken links', async () => {
    const { manifest } = await buildDocs(REPO);
    const sources = manifest.sections.flatMap((s) => s.pages.map((p) => p.source));
    const adrs = readdirSync(path.join(REPO, 'docs/adr')).filter((f) => f.endsWith('.md'));

    expect(sources).toEqual(
      expect.arrayContaining(['docs/api.md', 'docs/signer.md', 'docs/multisig.md', 'CONTEXT.md']),
    );
    expect(sources.filter((s) => s.startsWith('docs/adr/'))).toHaveLength(adrs.length);
    expect(sources.some((s) => s.startsWith('docs/agents/'))).toBe(false);
  });

  it('lists sections in table order, leaves out empty ones, and numbers the decisions', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);

    expect(manifest.sections.map((s) => s.title)).toEqual(['Guides', 'Decisions']);
    const decisions = manifest.sections[1]!.pages;
    expect(decisions.map((p) => [p.slug, p.title])).toEqual([
      ['adr/0001', 'First decision'],
      ['adr/0002', 'Second decision'],
    ]);
    expect(decisions[0]!.adr).toEqual({ number: '0001', status: 'superseded by ADR-0002' });
    expect(manifest.sections[0]!.pages.map((p) => p.label)).toEqual(['Page A', 'Bee']);
  });

  it('rewrites links to site routes and repo files to GitHub', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);
    const html = manifest.sections[0]!.pages[0]!.html;

    expect(html).toContain('href="/docs/b#hello"');
    expect(html).toContain('href="https://github.com/RbMo7/dispatch/blob/main/src/x.ts"');
    expect(html).toContain('href="#post-v1x"');
  });

  it('badges API route headings and turns titled code blocks into tabs', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);
    const page = manifest.sections[0]!.pages[0]!;

    expect(page.headings).toEqual([
      { id: 'post-v1x', depth: 2, text: 'POST /v1/x', method: 'POST' },
    ]);
    expect(page.html).toContain('data-method="POST"');
    expect(page.html.match(/role="tab"/g)).toHaveLength(2);
    expect(page.html).toMatch(/role="tabpanel"[^>]*hidden/);
    expect(page.html).toContain('data-copy');
  });

  it('indexes headings and body text for search', async () => {
    const { searchIndex } = await buildDocs(repo(VALID), NAV);
    const index = JSON.parse(searchIndex) as { documentIds: Record<string, string> };

    expect(Object.values(index.documentIds)).toEqual(
      expect.arrayContaining(['b#hello', 'a#post-v1x', 'adr/0001#']),
    );
  });

  it('fails the build naming every broken link, broken anchor and unlisted file', async () => {
    const root = repo({
      ...VALID,
      'docs/a.md': '# A\n\n[gone](./missing.md) [bad](./b.md#nope) [here](#nowhere)\n',
      'docs/stray.md': '# Stray\n',
    });

    const failure = buildDocs(root, NAV);
    await expect(failure).rejects.toThrow('docs/a.md: link "./missing.md"');
    await expect(failure).rejects.toThrow('docs/a.md: link "./b.md#nope"');
    await expect(failure).rejects.toThrow('docs/a.md: link "#nowhere"');
    await expect(failure).rejects.toThrow('docs/stray.md: not in the nav table');
  });
});
