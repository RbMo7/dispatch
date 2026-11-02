import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

/**
 * docs/openapi.yaml, read into the shape the reference pages and the sample runner need. One name
 * links a request to its answer: the request example `payBase` (body, parameters and headers)
 * produces the response example `payBase`, under the status it sits in. `unauthorized` is sent with
 * a wrong token, and `notOperator` with the API token to an operator-only route.
 * src/api/openapi.contract.test.ts holds the engine to the same convention.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = { [key: string]: Json };

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export interface ApiParameter {
  name: string;
  in: 'header' | 'path' | 'query';
  required: boolean;
  description: string;
  schema: Schema;
  examples: Record<string, Json>;
}

export interface ApiResponse {
  status: string;
  description: string;
  schema: Schema | undefined;
  examples: Record<string, { summary: string; value: Json }>;
}

export interface Scenario {
  name: string;
  summary: string;
  status: string;
  /** The path with every parameter filled in, and the query string, if any. */
  url: string;
  headers: [string, string][];
  body: Json | undefined;
  /** `valid` sends the engine's token, `wrong` a wrong one, `none` no Authorization header. */
  token: 'valid' | 'wrong' | 'none';
  response: Json;
}

export interface ApiOperation {
  anchor: string;
  operationId: string;
  tag: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  secured: boolean;
  /** Only the operator token is accepted: the route lists `operatorToken` as its one scheme. */
  operatorOnly: boolean;
  parameters: ApiParameter[];
  body: Schema | undefined;
  responses: ApiResponse[];
  scenarios: Scenario[];
}

export interface ApiTag {
  name: string;
  description: string;
  operations: ApiOperation[];
}

export interface ApiSpec {
  source: string;
  security: string;
  operatorSecurity: string;
  tags: ApiTag[];
}

/** A spec value as display text: a string as it is, anything else as JSON, nothing as empty. */
export function asText(node: Json | undefined): string {
  if (node === undefined || node === null) return '';
  return typeof node === 'string' ? node : JSON.stringify(node);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function loadOpenApi(root: string, source: string): ApiSpec {
  const spec = parse(readFileSync(path.join(root, source), 'utf8')) as Schema;
  const deref = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(deref);
    if (node === null || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') return deref(at(spec, node.$ref));
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, deref(value)]));
  };

  const operations: ApiOperation[] = [];
  for (const [opPath, item] of Object.entries(spec.paths as Record<string, Schema>)) {
    for (const method of HTTP_METHODS) {
      const raw = item[method] as Schema | undefined;
      if (!raw) continue;
      const op = deref(raw) as Schema;
      const parameters = ((op.parameters ?? []) as Schema[]).map((p): ApiParameter => ({
        name: asText(p.name),
        in: p.in as ApiParameter['in'],
        required: p.required === true,
        description: asText(p.description),
        schema: (p.schema ?? {}) as Schema,
        examples: Object.fromEntries(
          Object.entries((p.examples ?? {}) as Record<string, Schema>).map(([name, ex]) => [
            name,
            ex.value ?? null,
          ]),
        ),
      }));
      const media = (node: Json | undefined) =>
        (node as Schema | undefined)?.['application/json'] as Schema | undefined;
      const requestMedia = media((op.requestBody as Schema | undefined)?.content);
      const responses = Object.entries(op.responses as Record<string, Schema>).map(
        ([status, response]): ApiResponse => {
          const content = media(response.content);
          return {
            status,
            description: asText(response.description),
            schema: content?.schema as Schema | undefined,
            examples: Object.fromEntries(
              Object.entries((content?.examples ?? {}) as Record<string, Schema>).map(
                ([name, ex]) => [
                  name,
                  { summary: asText(ex.summary ?? name), value: ex.value ?? null },
                ],
              ),
            ),
          };
        },
      );
      const secured = !(Array.isArray(op.security) && op.security.length === 0);
      const operatorOnly =
        Array.isArray(op.security) &&
        op.security.length > 0 &&
        op.security.every((scheme) => 'operatorToken' in (scheme as Schema));
      const requestExamples = (requestMedia?.examples ?? {}) as Record<string, Schema>;
      const scenarios = responses.flatMap((response) =>
        Object.entries(response.examples).map(([name, example]): Scenario => {
          const valueOf = (location: ApiParameter['in']) =>
            parameters.flatMap((p): [string, string][] => {
              const value = p.in === location ? p.examples[name] : undefined;
              return value === undefined || value === null ? [] : [[p.name, asText(value)]];
            });
          const filled = opPath.replace(/\{(\w+)\}/g, (_, key: string) =>
            String(valueOf('path').find(([name]) => name === key)?.[1] ?? `{${key}}`),
          );
          const query = new URLSearchParams(valueOf('query')).toString();
          return {
            name,
            summary: example.summary,
            status: response.status,
            url: query ? `${filled}?${query}` : filled,
            headers: valueOf('header'),
            body: requestExamples[name]?.value,
            token: !secured ? 'none' : name === 'unauthorized' ? 'wrong' : 'valid',
            response: example.value,
          };
        }),
      );
      const summary = asText(op.summary);
      operations.push({
        anchor: slugify(summary),
        operationId: asText(op.operationId),
        tag: String((op.tags as string[])[0]),
        method: method.toUpperCase(),
        path: opPath,
        summary,
        description: asText(op.description),
        secured,
        operatorOnly,
        parameters,
        body: requestMedia?.schema as Schema | undefined,
        responses,
        // An answer with no request to show, such as a 413 for a body over 1 MiB, stays out of
        // the samples; the status table still lists it.
        scenarios: scenarios
          .filter((scenario) => !requestMedia || scenario.body !== undefined)
          .sort((a, b) => a.status.localeCompare(b.status)),
      });
    }
  }

  const schemes = ((spec.components as Schema).securitySchemes ?? {}) as Record<string, Schema>;
  return {
    source,
    security: asText(schemes.apiToken?.description),
    operatorSecurity: asText(schemes.operatorToken?.description),
    tags: ((spec.tags ?? []) as Schema[]).map((tag) => ({
      name: asText(tag.name),
      description: asText(tag.description),
      operations: operations.filter((op) => op.tag === tag.name),
    })),
  };
}

function at(spec: Schema, ref: string): Json {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<Json>(
      (node, key) => (node as Schema)[key.replace(/~1/g, '/').replace(/~0/g, '~')] as Json,
      spec,
    );
}

// The three samples print the same two things, the status and the JSON body, so a reader can
// compare them and scripts/doc-examples.ts can run them.

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function literal(value: Json, indent: string, style: 'js' | 'python'): string {
  if (value === null) return style === 'js' ? 'null' : 'None';
  if (typeof value === 'boolean') return style === 'js' ? String(value) : value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return style === 'js'
      ? `'${JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
      : JSON.stringify(value);
  }
  const inner = indent + (style === 'js' ? '  ' : '    ');
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => `${inner}${literal(v, inner, style)},`).join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const key = (k: string) => (style === 'js' && IDENTIFIER.test(k) ? k : JSON.stringify(k));
  return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${literal(v, inner, style)},`).join('\n')}\n${indent}}`;
}

/** The headers a sample sends. The token is a `token` entry, so each language writes its own variable. */
function requestHeaders(scenario: Scenario): [string, string, 'token' | 'text'][] {
  return [
    ...(scenario.token === 'none'
      ? []
      : [
          [
            'Authorization',
            'Bearer wrong-token',
            scenario.token === 'valid' ? 'token' : 'text',
          ] as const,
        ]),
    ...scenario.headers.map(([k, v]) => [k, v, 'text'] as const),
    ...(scenario.body === undefined ? [] : [['Content-Type', 'application/json', 'text'] as const]),
  ].map(([name, value, kind]): [string, string, 'token' | 'text'] => [name, value, kind]);
}

export function curlSample(op: ApiOperation, scenario: Scenario): string {
  const lines = [`curl -s -X ${op.method} "$DISPATCH_URL${scenario.url}"`];
  for (const [name, value, kind] of requestHeaders(scenario)) {
    const shown = kind === 'token' ? 'Bearer $DISPATCH_TOKEN' : value;
    lines.push(`-H "${name}: ${shown}"`);
  }
  if (scenario.body !== undefined) {
    const json = JSON.stringify(scenario.body, null, 2).replace(/'/g, "'\\''");
    lines.push(`-d '${json.replace(/\n/g, '\n  ')}'`);
  }
  return lines.join(' \\\n  ');
}

export function javascriptSample(op: ApiOperation, scenario: Scenario): string {
  const headers = requestHeaders(scenario).map(([name, value, kind]) => {
    const key = IDENTIFIER.test(name) ? name : `'${name}'`;
    const shown = kind === 'token' ? '`Bearer ${process.env.DISPATCH_TOKEN}`' : `'${value}'`;
    return `    ${key}: ${shown},`;
  });
  const options = [
    `  method: '${op.method}',`,
    ...(headers.length > 0 ? ['  headers: {', ...headers, '  },'] : []),
    ...(scenario.body === undefined
      ? []
      : [`  body: JSON.stringify(${literal(scenario.body, '  ', 'js')}),`]),
  ];
  return [
    `const response = await fetch(\`\${process.env.DISPATCH_URL}${scenario.url}\`, {`,
    ...options,
    '});',
    'console.log(response.status, await response.json());',
  ].join('\n');
}

export function pythonSample(op: ApiOperation, scenario: Scenario): string {
  // requests sets Content-Type itself for `json=`.
  const sent = requestHeaders(scenario).filter(([name]) => name !== 'Content-Type');
  const headers = sent.map(([name, value, kind]) => {
    const shown =
      kind === 'token' ? `f"Bearer {os.environ['DISPATCH_TOKEN']}"` : JSON.stringify(value);
    return `        "${name}": ${shown},`;
  });
  const args = [
    `    f"{os.environ['DISPATCH_URL']}${scenario.url.replace(/[{}]/g, (c) => c + c)}",`,
    ...(headers.length > 0 ? ['    headers={', ...headers, '    },'] : []),
    ...(scenario.body === undefined
      ? []
      : [`    json=${literal(scenario.body, '    ', 'python')},`]),
  ];
  return [
    'import os',
    '',
    'import requests',
    '',
    `response = requests.${op.method.toLowerCase()}(`,
    ...args,
    ')',
    'print(response.status_code, response.json())',
  ].join('\n');
}

export const SAMPLE_LANGUAGES = [
  { title: 'cURL', lang: 'shellscript', sample: curlSample },
  { title: 'JavaScript', lang: 'javascript', sample: javascriptSample },
  { title: 'Python', lang: 'python', sample: pythonSample },
] as const;
