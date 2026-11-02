import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const HEADER = '# Written by pnpm dispatch init';

export function parseEnvText(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

function quoted(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * `text` with each update applied: a variable already in the file is
 * replaced where it stands (every occurrence, so no later duplicate wins),
 * and a new one is appended. Every other line is kept as it was. An empty
 * value clears a variable the file has and is not appended.
 */
export function updateEnvText(text: string, updates: Readonly<Record<string, string>>): string {
  const seen = new Set<string>();
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const kept = lines.map((line) => {
    const name = LINE.exec(line)?.[1];
    if (name === undefined || !Object.hasOwn(updates, name)) return line;
    seen.add(name);
    return `${name}=${quoted(updates[name]!)}`;
  });
  const added = Object.entries(updates).filter(([name, value]) => !seen.has(name) && value !== '');
  if (added.length > 0) {
    if (kept.length > 0 && kept.at(-1) !== '') kept.push('');
    if (!kept.includes(HEADER)) kept.push(HEADER);
    for (const [name, value] of added) kept.push(`${name}=${quoted(value)}`);
  }
  return `${kept.join('\n')}\n`;
}

/** `20261101-142233`, local time: sorts by when, and is safe in a file name. */
export function backupStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Writes `content` to `file` with mode 0600, copying what was there to
 * `<file>.backup-<stamp>` first (also 0600). The write goes through a
 * temporary file and a rename, so a crash leaves the old file or the new
 * one, never half of either. Returns the backup's path, if one was taken.
 */
export function writePrivateFile(file: string, content: string, now: Date): string | undefined {
  let backup: string | undefined;
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') === content) {
      chmodSync(file, 0o600);
      return undefined;
    }
    backup = `${file}.backup-${backupStamp(now)}`;
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return backup;
}
