import type { Element, ElementContent, Properties, Root } from 'hast';
import { toHtml } from 'hast-util-to-html';

import type { DocHeading, HttpMethod } from '../src/docs/manifest.ts';
import {
  type ApiOperation,
  asText,
  type ApiParameter,
  type ApiSpec,
  type ApiTag,
  type Json,
  SAMPLE_LANGUAGES,
  type Scenario,
  type Schema,
  schemaName,
} from './openapi.ts';

/** What the reference builder borrows from the Markdown renderer, so both render alike. */
export interface Renderers {
  markdown: (source: string) => ElementContent[];
  code: (source: string, lang: string, title?: string) => Element;
  tabs: (panels: Element[], id: string) => Element;
}

const REASONS: Record<string, string> = {
  '200': 'OK',
  '202': 'Accepted',
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '404': 'Not Found',
  '409': 'Conflict',
};

const LOCATIONS: [ApiParameter['in'], string][] = [
  ['header', 'Headers'],
  ['path', 'Path parameters'],
  ['query', 'Query parameters'],
];

function el(tagName: string, properties: Properties, children: ElementContent[]): Element {
  return { type: 'element', tagName, properties, children };
}

function text(value: string): ElementContent {
  return { type: 'text', value };
}

/**
 * Markup kept as raw text the HTML parser does not build into elements, inside a script block that
 * never runs; `Article` builds it into the document when it is first shown.
 */
function lazy(content: ElementContent[]): Element {
  const html = toHtml({ type: 'root', children: content });
  if (/<\/script/i.test(html)) throw new Error('lazy markup cannot contain a closing script tag');
  return el('script', { type: 'text/html', dataLazy: true }, [text(html)]);
}

function code(value: string): Element {
  return el('code', {}, [text(value)]);
}

/**
 * One reference page: the tag's description, then each operation in GitHub's two columns. The left
 * column describes it (authentication, a parameter table per location, the status codes); the
 * right column shows a request in cURL, JavaScript and Python and the answer, for each named
 * example, chosen from a menu.
 */
export function referenceTree(
  tag: ApiTag,
  spec: ApiSpec,
  render: Renderers,
): { tree: Root; headings: DocHeading[] } {
  let group = 0;
  const nextId = () => `ref-${tag.name.toLowerCase()}-${++group}`;
  const headings: DocHeading[] = [];
  const children: ElementContent[] = [
    ...render.markdown(tag.description),
    el(
      'ul',
      { className: ['op-index'] },
      tag.operations.map((op) =>
        el('li', {}, [
          el('a', { href: `#${op.anchor}` }, [
            el('span', { className: ['method'], dataMethod: op.method }, [text(op.method)]),
            text(` ${op.summary}`),
          ]),
        ]),
      ),
    ),
  ];

  for (const op of tag.operations) {
    headings.push({
      id: op.anchor,
      depth: 2,
      text: `${op.method} ${op.summary}`,
      method: op.method as HttpMethod,
    });
    children.push(
      el('h2', { id: op.anchor, className: ['op-title'] }, [text(op.summary)]),
      el('div', { className: ['op'] }, [
        el('div', { className: ['op-doc'] }, [
          el('p', { className: ['op-route'] }, [
            el('span', { className: ['method'], dataMethod: op.method }, [text(op.method)]),
            text(' '),
            code(op.path),
          ]),
          ...render.markdown(op.description),
          ...authentication(op, spec, render),
          ...parameters(op, render),
          ...statusCodes(op, render),
        ]),
        el('aside', { className: ['op-samples'], dataSearch: 'skip' }, samples(op, render, nextId)),
      ]),
    );
  }
  return { tree: { type: 'root', children }, headings };
}

function subheading(op: ApiOperation, title: string): Element {
  return el('h3', { id: `${op.anchor}--${title.toLowerCase().replace(/\W+/g, '-')}` }, [
    text(`${title} for "${op.summary}"`),
  ]);
}

function authentication(op: ApiOperation, spec: ApiSpec, render: Renderers): ElementContent[] {
  return [
    subheading(op, 'Authentication'),
    ...(!op.secured
      ? render.markdown('None. This route needs no token.')
      : op.operatorOnly
        ? render.markdown(
            `Send the operator token as a bearer token: \`Authorization: Bearer <OPERATOR_TOKEN>\`. ${spec.operatorSecurity}`,
          )
        : render.markdown(
            `Send the API token as a bearer token: \`Authorization: Bearer <AUTH_TOKEN>\`. ${spec.security}`,
          )),
  ];
}

function parameters(op: ApiOperation, render: Renderers): ElementContent[] {
  const sections: ElementContent[] = [];
  for (const [location, title] of LOCATIONS) {
    const params = op.parameters.filter((p) => p.in === location);
    if (params.length === 0) continue;
    sections.push(
      el('h4', {}, [text(title)]),
      paramTable(
        params.map((p) => ({
          name: p.name,
          schema: p.schema,
          required: p.required,
          description: p.description,
        })),
        render,
      ),
    );
  }
  if (op.body) {
    sections.push(el('h4', {}, [text('Body parameters')]));
    const variants = (op.body.oneOf as Schema[] | undefined) ?? [op.body];
    for (const variant of variants) {
      if (variants.length > 1) {
        sections.push(el('p', { className: ['param-variant'] }, [text(asText(variant.title))]));
      }
      sections.push(paramTable(propertyRows(variant), render));
    }
  }
  return sections.length > 0 ? [subheading(op, 'Parameters'), ...sections] : [];
}

interface Row {
  name: string;
  schema: Schema;
  required: boolean;
  description: string;
}

function propertyRows(schema: Schema): Row[] {
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries((schema.properties ?? {}) as Record<string, Schema>).map(
    ([name, property]) => ({
      name,
      schema: property,
      required: required.has(name),
      description: asText(property.description),
    }),
  );
}

export function typeName(schema: Schema): string {
  if (typeof schema.$ref === 'string') return schemaName(schema.$ref);
  if (Array.isArray(schema.oneOf)) {
    return [...new Set((schema.oneOf as Schema[]).map(typeName))].join(' or ');
  }
  if (schema.const !== undefined) return typeof schema.const;
  const type = schema.type;
  if (Array.isArray(type)) return type.map(asText).join(' or ');
  if (type === 'array') {
    return `array of ${typeName((schema.items ?? {}) as Schema)}s`;
  }
  return typeof type === 'string' ? type : 'any';
}

function allowedValues(schema: Schema): Json[] | undefined {
  if (schema.const !== undefined) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return undefined;
}

function paramTable(rows: Row[], render: Renderers): Element {
  return el('table', { className: ['params'] }, [
    el('thead', {}, [
      el('tr', {}, [el('th', {}, [text('Name, type')]), el('th', {}, [text('Description')])]),
    ]),
    el(
      'tbody',
      {},
      rows.map((row) => {
        const allowed = allowedValues(row.schema);
        const nested = nestedTables(row, render);
        return el('tr', {}, [
          el('td', { className: ['param-name'] }, [
            code(row.name),
            el('span', { className: ['param-type'] }, [text(typeName(row.schema))]),
            ...(row.required
              ? [el('span', { className: ['param-required'] }, [text('Required')])]
              : []),
          ]),
          el('td', {}, [
            ...render.markdown(row.description),
            ...(allowed
              ? [
                  el('p', { className: ['param-meta'] }, [
                    text(allowed.length === 1 ? 'Value: ' : 'Can be one of: '),
                    ...allowed.flatMap((value, i) => [
                      ...(i > 0 ? [text(', ')] : []),
                      code(asText(value)),
                    ]),
                  ]),
                ]
              : []),
            ...(row.schema.default !== undefined
              ? [
                  el('p', { className: ['param-meta'] }, [
                    text('Default: '),
                    code(JSON.stringify(row.schema.default)),
                  ]),
                ]
              : []),
            ...nested,
          ]),
        ]);
      }),
    ),
  ]);
}

/** An object or array of objects gets its properties in a collapsed table, one per variant. */
function nestedTables(row: Row, render: Renderers): Element[] {
  const inner = row.schema.type === 'array' ? ((row.schema.items ?? {}) as Schema) : row.schema;
  const variants = Array.isArray(inner.oneOf) ? (inner.oneOf as Schema[]) : [inner];
  return variants
    .filter((variant) => variant.properties !== undefined)
    .map((variant) =>
      el('details', { className: ['param-nested'] }, [
        el('summary', {}, [
          text(variants.length > 1 ? `${asText(variant.title)}: properties of ` : 'Properties of '),
          code(row.name),
        ]),
        paramTable(propertyRows(variant), render),
      ]),
    );
}

function statusCodes(op: ApiOperation, render: Renderers): ElementContent[] {
  return [
    subheading(op, 'HTTP response status codes'),
    el('table', { className: ['statuses'] }, [
      el('thead', {}, [
        el('tr', {}, [el('th', {}, [text('Status code')]), el('th', {}, [text('Description')])]),
      ]),
      el(
        'tbody',
        {},
        op.responses.map((response) =>
          el('tr', {}, [
            el('td', {}, [code(response.status), text(` ${REASONS[response.status] ?? ''}`)]),
            el('td', {}, render.markdown(response.description)),
          ]),
        ),
      ),
    ]),
  ];
}

/** The left column already says what each field means, so the schema tab shows only its shape. */
function withoutDescriptions(node: Json): Json {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

function samples(op: ApiOperation, render: Renderers, nextId: () => string): ElementContent[] {
  const [first] = op.scenarios;
  if (!first) return [];
  const menu = el('label', { className: ['sample-menu'] }, [
    el('span', {}, [text('Example')]),
    el(
      'select',
      { dataExampleSelect: op.anchor },
      op.scenarios.map((scenario) =>
        el('option', { value: scenario.name, selected: scenario === first }, [
          text(`${scenario.summary} (${scenario.status})`),
        ]),
      ),
    ),
  ]);
  // A schema belongs to a status, not to an example: several examples share one, and it is by far
  // the largest block on the page, so each status's schema is rendered once and shown alongside
  // whichever of its examples is picked. Only the first example is built with the page; the page
  // builds the others when they are picked.
  const statuses = [...new Set(op.scenarios.map((scenario) => scenario.status))];
  const forExample = (scenario: Scenario, content: ElementContent[]) =>
    el(
      'div',
      {
        dataExample: scenario.name,
        dataOp: op.anchor,
        dataStatus: scenario.status,
        hidden: scenario !== first,
      },
      scenario === first ? content : [lazy(content)],
    );
  return [
    el('div', { className: ['sample'] }, [
      el('div', { className: ['sample-head'] }, [
        el('p', { className: ['sample-title'] }, [text('Request example')]),
        ...(op.scenarios.length > 1 ? [menu] : []),
      ]),
      ...op.scenarios.map((scenario) =>
        forExample(scenario, [
          el('p', { className: ['sample-route'] }, [
            el('span', { className: ['method'], dataMethod: op.method }, [text(op.method)]),
            text(' '),
            code(scenario.url),
          ]),
          render.tabs(
            SAMPLE_LANGUAGES.map(({ title, lang, sample }) =>
              render.code(sample(op, scenario), lang, title),
            ),
            nextId(),
          ),
        ]),
      ),
      el('p', { className: ['sample-title'] }, [text('Response')]),
      ownTabs(
        render.tabs(
          [
            el(
              'div',
              { dataTitle: 'Example response' },
              op.scenarios.map((scenario) =>
                forExample(scenario, [
                  el('p', { className: ['sample-status'] }, [text(`Status: ${scenario.status}`)]),
                  render.code(JSON.stringify(scenario.response, null, 2), 'json'),
                ]),
              ),
            ),
            el(
              'div',
              { dataTitle: 'Response schema' },
              statuses.map((status) => {
                const schema = op.responses.find((r) => r.status === status)?.schema;
                return el(
                  'div',
                  { dataSchemaOp: op.anchor, dataStatus: status, hidden: status !== first.status },
                  [
                    el('p', { className: ['sample-status'] }, [text(`Status: ${status}`)]),
                    // Highlighted, a schema is thousands of elements, in a tab most readers never
                    // open; the page builds it when the tab is first shown.
                    lazy([
                      render.code(
                        JSON.stringify(withoutDescriptions(schema ?? {}), null, 2),
                        'json',
                      ),
                    ]),
                  ],
                );
              }),
            ),
          ],
          nextId(),
        ),
      ),
    ]),
  ];
}

/**
 * Picking a language switches every sample on the page; the response tabs belong to one
 * operation, so opening a schema builds only that operation's.
 */
function ownTabs(group: Element): Element {
  group.properties = { ...group.properties, dataOwnTabs: true };
  return group;
}
