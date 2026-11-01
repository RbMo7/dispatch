// Runs the docs' examples against a running engine.
//
//   node web/scripts/doc-examples.ts                  list every code block in docs/ that can run, marking
//                                                     the API ones
//   node web/scripts/doc-examples.ts --run [file…]    run the API blocks and print each response
//   node web/scripts/doc-examples.ts --check [file…]  run them, compare each shell response's keys with
//                                                     the JSON block shown after it, and fail on a
//                                                     JavaScript or Python block that exits non-zero
//   node web/scripts/doc-examples.ts --api [opId…]    run every reference sample, in cURL, JavaScript and
//                                                     Python, and compare each answer's status and keys
//                                                     with the example in docs/openapi.yaml
//
// An API block is a sh, JavaScript or Python block that uses DISPATCH_URL. Everything but the listing needs DISPATCH_URL and
// DISPATCH_TOKEN set. Blocks in one file run in order, and the last dispatchId a response returned is
// passed on as $DISPATCH_ID, so a page can create a Dispatch and then read it. The Python samples need
// `requests`; set PYTHON to an interpreter that has it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Json, loadOpenApi, SAMPLE_LANGUAGES } from './openapi.ts';

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
const PROGRAMS = new Set(['js', 'javascript', 'python']);
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
    if (!SHELL.has(block.lang) && !PROGRAMS.has(block.lang)) return [];
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

const isApiBlock = (block: Block) => block.code.includes('DISPATCH_URL');

const CURL = `curl() { command curl -sS -w '\\nHTTP %{http_code}\\n' "$@"; }\n`;

const SETS_TARGET = /^\s*export (DISPATCH_URL|DISPATCH_TOKEN)=/;

function runShell(code: string, env: NodeJS.ProcessEnv): { status: string; body: string } {
  const script = code
    .split('\n')
    .filter((line) => !SETS_TARGET.test(line))
    .join('\n');
  const result = spawnSync('bash', ['-c', CURL + script], { env, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`.trimEnd();
  const status = /HTTP (\d{3})$/.exec(output)?.[1] ?? '???';
  return { status, body: output.replace(/\nHTTP \d{3}$/, '').trim() };
}

/** Every sample prints the status and the body; these make each language print them as one JSON line. */
const CAPTURE = {
  javascript: (sample: string) =>
    `const __print = console.log;\nconsole.log = (status, body) => __print(JSON.stringify({ status, body }));\n${sample}\n`,
  python: (sample: string) =>
    `import builtins, json, sys\nbuiltins.print = lambda status, body: sys.stdout.write(json.dumps({"status": status, "body": body}) + "\\n")\n${sample}\n`,
};

function runSample(
  lang: string,
  sample: string,
  env: NodeJS.ProcessEnv,
): { status: string; body: string } {
  if (lang === 'shellscript') return runShell(sample, env);
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-sample-'));
  try {
    const file = path.join(dir, lang === 'python' ? 'sample.py' : 'sample.mjs');
    writeFileSync(file, CAPTURE[lang as 'python' | 'javascript'](sample));
    const command = lang === 'python' ? (env.PYTHON ?? 'python3') : process.execPath;
    const result = spawnSync(command, [file], { env, encoding: 'utf8' });
    try {
      const { status, body } = JSON.parse(result.stdout) as { status: number; body: Json };
      return { status: String(status), body: JSON.stringify(body) };
    } catch {
      return { status: '???', body: `${result.stdout}${result.stderr}`.trim() };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A JavaScript or Python block from a page, run as it is shown. */
function runProgram(
  lang: string,
  code: string,
  env: NodeJS.ProcessEnv,
): { code: number; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-block-'));
  try {
    const python = lang === 'python';
    const file = path.join(dir, python ? 'block.py' : 'block.mjs');
    writeFileSync(file, code);
    const result = spawnSync(python ? (env.PYTHON ?? 'python3') : process.execPath, [file], {
      env,
      encoding: 'utf8',
    });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

function sameKeys(shown: unknown, real: string): string | undefined {
  let realJson: unknown;
  try {
    realJson = JSON.parse(real);
  } catch {
    return 'the response is not JSON';
  }
  const keys = (value: unknown): string => JSON.stringify(shape(value));
  return keys(shown) === keys(realJson)
    ? undefined
    : `keys differ\n  shown: ${keys(shown)}\n  real:  ${keys(realJson)}`;
}

function parseShown(shown: string): unknown {
  try {
    return JSON.parse(shown.replaceAll('…', ''));
  } catch {
    return Symbol('unparsable');
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--api')
  ? 'api'
  : args.includes('--check')
    ? 'check'
    : args.includes('--run')
      ? 'run'
      : 'list';
const only = args.filter((arg) => !arg.startsWith('--'));

if (mode === 'list') {
  const blocks = (only.length > 0 ? only : markdownFiles('docs')).flatMap(blocksOf);
  for (const block of blocks) {
    const tag = isApiBlock(block) ? 'api ' : 'sh  ';
    const first = block.code.split('\n')[0] ?? '';
    console.log(
      `${tag} ${block.file}:${block.line}${block.title ? ` [${block.title}]` : ''}  ${first}`,
    );
  }
  console.log(
    `\n${blocks.length} shell blocks, ${blocks.filter(isApiBlock).length} of them API calls`,
  );
  process.exit(0);
}

if (!process.env.DISPATCH_URL || !process.env.DISPATCH_TOKEN) {
  console.error('set DISPATCH_URL and DISPATCH_TOKEN to a running engine first');
  process.exit(2);
}

let failures = 0;

if (mode === 'api') {
  const spec = loadOpenApi(ROOT, 'docs/openapi.yaml');
  for (const op of spec.tags.flatMap((tag) => tag.operations)) {
    if (only.length > 0 && !only.includes(op.operationId)) continue;
    for (const scenario of op.scenarios) {
      for (const { title, lang, sample } of SAMPLE_LANGUAGES) {
        const { status, body } = runSample(lang, sample(op, scenario), process.env);
        const problem =
          status !== scenario.status
            ? `status ${status}, documented ${scenario.status}\n${pretty(body)}`
            : sameKeys(scenario.response, body);
        if (problem) failures++;
        console.log(
          `${problem ? 'FAIL' : 'ok  '} ${op.operationId} ${scenario.name} [${title}] ${status}${problem ? `\n  ${problem}` : ''}`,
        );
        if (args.includes('--print')) console.log(pretty(body));
      }
    }
  }
  console.log(failures === 0 ? '\nevery sample answers as documented' : `\n${failures} mismatches`);
  process.exit(failures === 0 ? 0 : 1);
}

for (const file of only.length > 0 ? only : markdownFiles('docs')) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const block of blocksOf(file).filter(isApiBlock)) {
    if (!SHELL.has(block.lang)) {
      const { code, output } = runProgram(block.lang, block.code, env);
      console.log(`\n=== ${block.file}:${block.line} [${block.title ?? block.lang}]  exit ${code}`);
      console.log(output);
      if (code !== 0) failures++;
      continue;
    }
    const { status, body } = runShell(block.code, env);
    const id = /"dispatchId":\s*"([^"]+)"/.exec(body)?.[1];
    if (id) env.DISPATCH_ID = id;
    console.log(
      `\n=== ${block.file}:${block.line}${block.title ? ` [${block.title}]` : ''}  HTTP ${status}`,
    );
    console.log(pretty(body));
    if (mode === 'check' && block.shownResponse !== undefined) {
      const problem = sameKeys(parseShown(block.shownResponse), body);
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
