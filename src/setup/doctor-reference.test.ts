import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CHECKS } from './checks.js';

const REFERENCE = 'docs/self-hosting/doctor.md';

/** Each check in the reference is a `### <title>` heading whose next line starts "Id `<id>`". */
function referencedChecks(markdown: string): { id: string; title: string }[] {
  const lines = markdown.split('\n');
  return lines.flatMap((line, i) => {
    const heading = /^### (.+)$/.exec(line);
    if (!heading) return [];
    const next = lines.slice(i + 1).find((l) => l.trim() !== '') ?? '';
    const id = /^Id `([^`]+)`/.exec(next);
    expect(
      id,
      `${REFERENCE}: "### ${heading[1]}" is not followed by an "Id \`...\`" line`,
    ).not.toBeNull();
    return [{ id: id![1]!, title: heading[1]! }];
  });
}

describe('the doctor reference', () => {
  it('lists exactly the checks in the registry, each under its title', () => {
    const documented = referencedChecks(readFileSync(REFERENCE, 'utf8'));
    const registered = CHECKS.map(({ id, title }) => ({ id, title }));
    expect(documented).toEqual(registered);
  });
});
