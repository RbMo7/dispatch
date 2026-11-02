import { readFileSync } from 'node:fs';

const MIN_RATIO = 4.5;

type Theme = 'light' | 'dark';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const tokens = new Map(
  [...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]),
);

const pillFills = [...tokens.keys()].flatMap((name): [string, string][] => {
  const tone = /^--pill-([\w-]+)-fg$/.exec(name)?.[1];
  return tone ? [[name, `--pill-${tone}-bg`]] : [];
});

const SURFACES = ['--canvas', '--surface', '--sunken', '--hover', '--accent-soft'];

const PAIRS: [text: string, fill: string][] = [
  ...pillFills,
  ...SURFACES.flatMap((fill): [string, string][] => [
    ['--ink', fill],
    ['--muted', fill],
  ]),
  ['--accent-text', '--surface'],
  ['--accent-text', '--accent-soft'],
  ['--on-accent', '--accent'],
  ['--on-accent', '--accent-hover'],
  ['--danger', '--surface'],
  ['--danger', '--danger-soft'],
  ['--ink', '--danger-soft'],
  ['--muted', '--danger-soft'],
  ['--on-danger', '--danger'],
  ['--ok-text', '--surface'],
  ['--warn-text', '--surface'],
  ['--warn-text', '--canvas'],
  ['--surface', '--ink'],
];

function resolve(name: string, theme: Theme): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`${name} is not defined in tokens.css`);
  return resolveValue(value, theme);
}

function resolveValue(value: string, theme: Theme): string {
  const pair = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(value);
  if (pair) return resolveValue(theme === 'light' ? pair[1]! : pair[2]!, theme);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolve(ref[1]!, theme);
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  throw new Error(`cannot read a colour from "${value}"`);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

let failures = 0;
for (const theme of ['light', 'dark'] as const) {
  for (const [text, fill] of PAIRS) {
    const ratio = contrast(resolve(text, theme), resolve(fill, theme));
    const ok = ratio >= MIN_RATIO;
    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${ratio.toFixed(2)}  ${text} on ${fill}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} pair(s) below ${MIN_RATIO}:1`);
  process.exit(1);
}
console.log(`\nall ${PAIRS.length * 2} pairs meet ${MIN_RATIO}:1`);
