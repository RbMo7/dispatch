// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  {
    title: 'Reference',
    pages: [{ source: 'docs/openapi.yaml', tag: 'Things', slug: 'rest/things' }],
  },
];

const SPEC = `openapi: 3.1.0
info: { title: Test, version: '1' }
tags:
  - name: Things
    description: Things you can make. See [B](./b.md#hello).
components:
  securitySchemes:
    apiToken: { type: http, scheme: bearer, description: The token. }
paths:
  /v1/things:
    post:
      tags: [Things]
      operationId: createThing
      summary: Create a thing
      description: Makes one thing.
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          description: A key.
          schema: { type: string }
          examples: { made: { value: thing-1 } }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [size]
              properties:
                size: { type: string, enum: [small, large], description: How big. }
            examples:
              made: { summary: A small thing, value: { size: small, fresh: true } }
      responses:
        '202':
          description: Made.
          content:
            application/json:
              schema: { type: object }
              examples:
                made: { summary: A small thing, value: { id: t-1 } }
`;

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
    'See [B](./b.md#hello), [the source](../src/x.ts), [here](#post-v1x) and [make one](./openapi.yaml#create-a-thing).',
    '',
    '![How a thing moves](./images/flow.svg)',
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
  'docs/images/flow.svg': '<svg xmlns="http://www.w3.org/2000/svg"><title>flow</title></svg>\n',
  'docs/openapi.yaml': SPEC,
  'docs/adr/0001-first.md': '# First decision\n',
  'docs/agents/internal.md': '# Not for the site\n',
  'src/x.ts': 'export {};\n',
};

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe('buildDocs', () => {
  it('renders the real docs, with no decision records and no broken links', async () => {
    const { manifest } = await buildDocs(REPO);
    const sources = manifest.sections.flatMap((s) => s.pages.map((p) => p.source));

    expect(sources).toEqual(expect.arrayContaining(['docs/quickstart.md', 'docs/openapi.yaml']));
    expect(sources.some((s) => s.startsWith('docs/adr/') || s.startsWith('docs/agents/'))).toBe(
      false,
    );
    expect(manifest.sections.map((s) => s.title)).toEqual([
      'Get started',
      'Guides',
      'REST API reference',
      'Self-hosting',
    ]);
    // It renders every real page and reference sample, so it grows with the docs.
  }, 30_000);

  it('lists sections in table order, leaves out empty ones, and keeps decision records off the site', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);

    expect(manifest.sections.map((s) => s.title)).toEqual(['Guides', 'Reference']);
    expect(manifest.sections[0]!.pages.map((p) => p.label)).toEqual(['Page A', 'Bee']);
  });

  it('rewrites links to site routes, repo files to GitHub, and operations to their reference page', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);
    const html = manifest.sections[0]!.pages[0]!.html;

    expect(html).toContain('href="/docs/b#hello"');
    expect(html).toContain('href="https://github.com/RbMo7/dispatch/blob/main/src/x.ts"');
    expect(html).toContain('href="#post-v1x"');
    expect(html).toContain('href="/docs/rest/things#create-a-thing"');
  });

  it('inlines an SVG diagram with its caption', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);
    const html = manifest.sections[0]!.pages[0]!.html;

    expect(html).toMatch(/<figure class="diagram"><svg[^>]*><title>flow<\/title><\/svg>/);
    expect(html).toContain('<figcaption>How a thing moves</figcaption>');
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

  it('builds a reference page from an OpenAPI tag, with samples generated from its example', async () => {
    const { manifest } = await buildDocs(repo(VALID), NAV);
    const page = manifest.sections[1]!.pages[0]!;

    expect(page).toMatchObject({
      title: 'Things',
      layout: 'reference',
      source: 'docs/openapi.yaml',
    });
    expect(page.headings).toEqual([
      { id: 'create-a-thing', depth: 2, text: 'POST Create a thing', method: 'POST' },
    ]);
    expect(page.html).toContain('href="/docs/b#hello"');
    for (const tab of ['cURL', 'JavaScript', 'Python', 'Example response', 'Response schema']) {
      expect(page.html).toContain(`data-tab="${tab}"`);
    }
    const text = page.html.replace(/<[^>]+>/g, '');
    expect(text).toContain('Idempotency-Key: thing-1');
    expect(text).toContain('fresh: true');
    expect(text).toMatch(/fresh\W{1,12}True/);
    expect(text).toContain('Status: 202');
    expect(text).toContain('Can be one of: small, large');
  });

  it('expands a schema that contains itself once, and names it where it recurs', async () => {
    const spec = SPEC.replace(
      'components:\n',
      [
        'components:',
        '  schemas:',
        '    Node:',
        '      type: object',
        "      properties: { children: { type: array, items: { $ref: '#/components/schemas/Node' } } }",
        '',
      ].join('\n'),
    ).replace(
      'description: How big. }\n',
      "description: How big. }\n                tree: { $ref: '#/components/schemas/Node' }\n",
    );
    const { manifest } = await buildDocs(repo({ ...VALID, 'docs/openapi.yaml': spec }), NAV);
    const text = manifest.sections[1]!.pages[0]!.html.replace(/<[^>]+>/g, '');

    expect(text).toContain('Properties of tree');
    expect(text).toContain('childrenarray of Nodes');
  });

  it('indexes headings and body text for search, but not the reference samples', async () => {
    const { searchIndex } = await buildDocs(repo(VALID), NAV);
    const index = JSON.parse(searchIndex) as { documentIds: Record<string, string> };

    expect(Object.values(index.documentIds)).toEqual(
      expect.arrayContaining(['b#hello', 'a#post-v1x', 'rest/things#create-a-thing']),
    );
    expect(searchIndex).not.toContain('requests.post');
  });

  it('fails the build naming every broken link, broken anchor, unlisted file and house-rule break', async () => {
    const root = repo({
      ...VALID,
      'docs/a.md':
        '# A\n\n[gone](./missing.md) [bad](./b.md#nope) [here](#nowhere) [op](./openapi.yaml#no-such-op)\n\nIt is simply done — see ADR-0046.\n\n```sh\necho just this\n```\n',
      'docs/stray.md': '# Stray\n',
    });

    const failure = buildDocs(root, NAV);
    await expect(failure).rejects.toThrow('docs/a.md: link "./missing.md"');
    await expect(failure).rejects.toThrow('docs/a.md: link "./b.md#nope"');
    await expect(failure).rejects.toThrow('docs/a.md: link "#nowhere"');
    await expect(failure).rejects.toThrow(
      'docs/a.md: link "./openapi.yaml#no-such-op" names no operation',
    );
    await expect(failure).rejects.toThrow('docs/stray.md: not in the nav table');
    await expect(failure).rejects.toThrow('docs/a.md: line 5 has an en or em dash');
    await expect(failure).rejects.toThrow('docs/a.md: line 5 has an ADR number: "ADR-0046"');
    await expect(failure).rejects.toThrow('docs/a.md: line 5 has a filler word: "simply"');
    await expect(failure).rejects.not.toThrow('"just"');
  });
});
