// Lists the shell examples in docs/, and runs the API ones against a local engine.
//
//   node web/scripts/doc-examples.ts                 list every shell block, marking the API ones
//   node web/scripts/doc-examples.ts --run [file…]   run the API blocks and print each response
//   node web/scripts/doc-examples.ts --check [file…] run them and compare each response's keys
//                                                    with the JSON block shown after it
//
// An API block is a sh block that uses $DISPATCH_URL. --run and --check need DISPATCH_URL and
// DISPATCH_TOKEN set. Blocks in one file run in order, and the last dispatchId a response
// returned is passed on as $DISPATCH_ID, so a page can create a Dispatch and then read it.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Block {
  file: string;
  line: number;
  lang: string;
  title: string | undefined;
  code: string;
  shownResponse: string | undefined;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIPPED_DIRS = new Set(['docs/agents', 'docs/adr']);
const SHELL = new Set(['sh', 'bash', 'shell']);
const FENCE = /^(\s*)(`{3,})(\S*)(.*)$/;

function markdownFiles(directory: string): string[] {
  if (SKIPPED_DIRS.has(directory)) return [];
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return markdownFiles(child);
      return entry.name.endsWith('.md') ? [child] : [];
    })
    .sort();
}

function blocksOf(file: string): Block[] {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const fenced: { line: number; lang: string; meta: string; code: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i] ?? '');
    if (!open) continue;
    const [, indent = '', ticks = '', lang = '', meta = ''] = open;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !(lines[j] ?? '').trim().startsWith(ticks)) {
      body.push((lines[j] ?? '').slice(indent.length));
      j++;
    }
    fenced.push({ line: i + 1, lang, meta, code: body.join('\n') });
    i = j;
  }
  return fenced.flatMap((block, index) => {
    if (!SHELL.has(block.lang)) return [];
    const next = fenced[index + 1];
    return [
      {
        file,
        line: block.line,
        lang: block.lang,
        title: /title="([^"]+)"/.exec(block.meta)?.[1],
        code: block.code,
        shownResponse: next?.lang === 'json' ? next.code : undefined,
      },
    ];
  });
}

const isApiBlock = (block: Block) => block.code.includes('$DISPATCH_URL');

const PREAMBLE = `curl() { command curl -sS -w '\\nHTTP %{http_code}\\n' "$@"; }\n`;

const SETS_TARGET = /^\s*export (DISPATCH_URL|DISPATCH_TOKEN)=/;

function run(block: Block, env: NodeJS.ProcessEnv): { status: string; body: string } {
  const code = block.code
    .split('\n')
    .filter((line) => !SETS_TARGET.test(line))
    .join('\n');
  const result = spawnSync('bash', ['-c', PREAMBLE + code], { env, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.trimEnd();
  const status = /HTTP (\d{3})$/.exec(output)?.[1] ?? '???';
  return { status, body: output.replace(/\nHTTP \d{3}$/, '').trim() };
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  }
  return 0;
}

function sameKeys(shown: string, real: string): string | undefined {
  let shownJson: unknown;
  let realJson: unknown;
  try {
    shownJson = JSON.parse(shown.replaceAll('…', ''));
  } catch {
    return 'the JSON shown after the block does not parse';
  }
  try {
    realJson = JSON.parse(real);
  } catch {
    return 'the response is not JSON';
  }
  const keys = (value: unknown): string => JSON.stringify(shape(value));
  return keys(shownJson) === keys(realJson)
    ? undefined
    : `keys differ\n  shown: ${keys(shownJson)}\n  real:  ${keys(realJson)}`;
}

const args = process.argv.slice(2);
const mode = args.includes('--check') ? 'check' : args.includes('--run') ? 'run' : 'list';
const only = args.filter((arg) => !arg.startsWith('--'));
const files = only.length > 0 ? only : markdownFiles('docs');
const blocks = files.flatMap(blocksOf);

if (mode === 'list') {
  for (const block of blocks) {
    const tag = isApiBlock(block) ? 'api ' : 'sh  ';
    const first = block.code.split('\n')[0] ?? '';
    console.log(`${tag} ${block.file}:${block.line}${block.title ? ` [${block.title}]` : ''}  ${first}`);
  }
  console.log(`\n${blocks.length} shell blocks, ${blocks.filter(isApiBlock).length} of them API calls`);
  process.exit(0);
}

if (!process.env.DISPATCH_URL || !process.env.DISPATCH_TOKEN) {
  console.error('set DISPATCH_URL and DISPATCH_TOKEN to a running engine first');
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const block of blocks.filter((b) => b.file === file && isApiBlock(b))) {
    const { status, body } = run(block, env);
    const id = /"dispatchId":"([^"]+)"/.exec(body)?.[1];
    if (id) env.DISPATCH_ID = id;
    console.log(`\n=== ${block.file}:${block.line}${block.title ? ` [${block.title}]` : ''}  HTTP ${status}`);
    console.log(pretty(body));
    if (mode === 'check' && block.shownResponse !== undefined) {
      const problem = sameKeys(block.shownResponse, body);
      if (problem) {
        failures++;
        console.log(`MISMATCH: ${problem}`);
      }
    }
  }
}
if (mode === 'check') {
  console.log(failures === 0 ? '\nevery shown response matches' : `\n${failures} mismatches`);
  process.exit(failures === 0 ? 0 : 1);
}
