import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted((): void => {
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.OPENAI_BASE_URL;
  process.env.OPENAI_MODEL = 'gpt-5.6-terra';
});

import { agentJsonWithMode, makeAgent } from '../../../src/lib/mastra';
import { charterSchema } from '../../../src/agent/charter';
import { workGenSchema } from '../../../src/agent/work-generator';
import { discoveryModelSchema } from '../../../src/docs/system-discovery';
import {
  dependentExecuteSchemaForProcedureContract,
  executeSchemaForProcedureContract,
  procedureContractSchema,
} from '../../../src/work/execute-skill';
import { planSchema } from '../../../src/work/plan';
import { qualityFitSchema } from '../../../src/work/quality-fit';
import { questionLabelSchema } from '../../../convex/onboarding';
import { orientationSchema } from '../../../convex/orientationActions';
import { authorSchema } from '../../../convex/skillActions';

/**
 * What OpenAI Structured Outputs accepts in a strict `json_schema`, and nothing
 * else. Every keyword in this set was accepted by `gpt-5.6-terra` through the
 * product client on 3 September 2026; `oneOf`, the keyword Zod emits for a
 * discriminated union, was refused with "'oneOf' is not permitted".
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'title',
  '$ref',
  '$defs',
  'definitions',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
]);
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const MAX_NESTING = 10;
const MAX_PROPERTIES = 5000;
const MAX_ENUM_VALUES = 1000;

interface Walk {
  violations: string[];
  properties: number;
  enumValues: number;
}

function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Walk one emitted JSON schema and list every strict-mode violation by path.
 *
 * Args:
 *   node: The schema node under inspection.
 *   path: Where the node sits, for the violation message.
 *   depth: Object and array nesting depth reached at this node.
 *   walk: The accumulator shared by the whole schema.
 */
function walkStrict(node: unknown, path: string, depth: number, walk: Walk): void {
  if (!isSchemaNode(node)) {
    walk.violations.push(`${path}: schema node is not an object`);
    return;
  }
  if (depth > MAX_NESTING) {
    walk.violations.push(`${path}: nesting deeper than ${MAX_NESTING} levels`);
  }
  for (const key of Object.keys(node)) {
    if (key === '$schema' && path === '$') continue;
    if (!ALLOWED_KEYWORDS.has(key)) walk.violations.push(`${path}: '${key}' is not permitted`);
  }
  const type = node.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  for (const entry of types) {
    if (typeof entry !== 'string' || !ALLOWED_TYPES.has(entry)) {
      walk.violations.push(`${path}: type '${String(entry)}' is not permitted`);
    }
  }
  if (Array.isArray(node.enum)) walk.enumValues += node.enum.length;
  if (types.includes('object') || isSchemaNode(node.properties)) {
    if (node.additionalProperties !== false) {
      walk.violations.push(`${path}: object must set additionalProperties: false`);
    }
    const properties = isSchemaNode(node.properties) ? node.properties : {};
    const names = Object.keys(properties);
    walk.properties += names.length;
    const required = Array.isArray(node.required) ? node.required : [];
    const missing = names.filter((name) => !required.includes(name));
    if (missing.length > 0) {
      walk.violations.push(`${path}: properties not marked required: ${missing.join(', ')}`);
    }
    for (const name of names) walkStrict(properties[name], `${path}.${name}`, depth + 1, walk);
  }
  if (types.includes('array')) {
    if (node.items === undefined) walk.violations.push(`${path}: array without items`);
    else walkStrict(node.items, `${path}[]`, depth + 1, walk);
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[combinator];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) =>
      walkStrict(branch, `${path}.${combinator}[${index}]`, depth, walk),
    );
  }
  for (const container of ['$defs', 'definitions'] as const) {
    const definitions = node[container];
    if (!isSchemaNode(definitions)) continue;
    for (const [name, definition] of Object.entries(definitions)) {
      walkStrict(definition, `${path}.${container}.${name}`, depth, walk);
    }
  }
}

/** Every strict-mode violation in an emitted schema, empty when it is clean. */
export function strictSchemaViolations(schema: unknown): string[] {
  const walk: Walk = { violations: [], properties: 0, enumValues: 0 };
  walkStrict(schema, '$', 0, walk);
  if (isSchemaNode(schema) && schema.type !== 'object') {
    walk.violations.unshift('$: root must be an object');
  }
  if (walk.properties > MAX_PROPERTIES) {
    walk.violations.push(`$: ${walk.properties} properties exceeds ${MAX_PROPERTIES}`);
  }
  if (walk.enumValues > MAX_ENUM_VALUES) {
    walk.violations.push(`$: ${walk.enumValues} enum values exceeds ${MAX_ENUM_VALUES}`);
  }
  return walk.violations;
}

const contract = procedureContractSchema.parse({
  trails: [
    {
      id: 'audit-comment',
      appliesTo: { sourceCategories: ['ticket-queue'] },
      effect: {
        tool: 'ticket.update',
        destination: { kind: 'originating-reference', refPrefix: 'ticket://' },
        requiredPayload: ['comment'],
        nonEmptyPayload: ['comment'],
        statusTransition: { argument: 'status', full: 'done', partial: 'in-progress' },
      },
      evidence: { documentRef: 'doc://ticket-guide', title: 'Ticket guide', excerpt: 'Comment.' },
    },
    {
      id: 'manager-update',
      appliesTo: { sourceCategories: ['inbox', 'ticket-queue'] },
      effect: {
        tool: 'slack.postMessage',
        destination: { kind: 'manager-channel', argument: 'channelSlug', value: 'dm-manager' },
        requiredPayload: ['body'],
        nonEmptyPayload: ['body'],
        statusTransition: null,
      },
      evidence: { documentRef: 'doc://slack-guide', title: 'Slack guide', excerpt: 'Tell them.' },
    },
  ],
});
const noTrails = procedureContractSchema.parse({ trails: [] });

/** Every schema a shipped Mastra agent sends as `response_format`. */
const MODEL_FACING_SCHEMAS: Array<{ agent: string; schema: unknown }> = [
  { agent: 'day0-charter', schema: charterSchema },
  { agent: 'day0-question-labeller', schema: questionLabelSchema },
  { agent: 'day0-documentation-discovery', schema: discoveryModelSchema },
  { agent: 'day0-orientation', schema: orientationSchema },
  { agent: 'day0-quality-fit', schema: qualityFitSchema },
  { agent: 'day0-plan', schema: planSchema },
  { agent: 'day0-work-generator', schema: workGenSchema },
  { agent: 'day0-skill-author', schema: authorSchema },
  {
    agent: 'executor real, two trails',
    schema: executeSchemaForProcedureContract(contract, undefined, undefined, 'real'),
  },
  {
    agent: 'executor real, no trails',
    schema: executeSchemaForProcedureContract(noTrails, undefined, undefined, 'real'),
  },
  {
    agent: 'executor mock, two trails',
    schema: executeSchemaForProcedureContract(contract, undefined, undefined, 'mock'),
  },
  {
    agent: 'executor mock, no trails',
    schema: executeSchemaForProcedureContract(noTrails, undefined, undefined, 'mock'),
  },
  {
    agent: 'dependent real, two trails',
    schema: dependentExecuteSchemaForProcedureContract(contract, 'real'),
  },
  {
    agent: 'dependent real, no trails',
    schema: dependentExecuteSchemaForProcedureContract(noTrails, 'real'),
  },
  {
    agent: 'dependent mock, two trails',
    schema: dependentExecuteSchemaForProcedureContract(contract, 'mock'),
  },
  {
    agent: 'dependent mock, no trails',
    schema: dependentExecuteSchemaForProcedureContract(noTrails, 'mock'),
  },
];

interface CapturedRequest {
  url: string;
  body: { text?: { format?: { type?: string; strict?: boolean; schema?: unknown } } };
}

/** Run one native structured call against a stubbed provider and keep the request. */
async function captureNativeRequest(agentName: string, schema: unknown): Promise<CapturedRequest> {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as CapturedRequest['body'] });
      return new Response(
        JSON.stringify({ error: { message: 'captured by the test', type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const agent = makeAgent(agentName.replace(/[^a-z0-9-]+/g, '-'), 'probe');
  await agentJsonWithMode({ agent, user: 'probe', schema, mode: 'native' }).catch(() => undefined);
  expect(requests).toHaveLength(1);
  return requests[0] as CapturedRequest;
}

describe('strict structured output schemas', (): void => {
  beforeEach((): void => {
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses the keywords strict mode refuses', (): void => {
    expect(
      strictSchemaViolations({
        type: 'object',
        properties: {
          rows: { type: 'array', items: { oneOf: [{ type: 'string' }] } },
          loose: { type: 'object', properties: { a: { type: 'string' } } },
          extra: { type: 'string', default: 'x' },
        },
        required: ['rows', 'loose'],
        additionalProperties: false,
      }),
    ).toEqual([
      '$: properties not marked required: extra',
      "$.rows[]: 'oneOf' is not permitted",
      '$.loose: object must set additionalProperties: false',
      '$.loose: properties not marked required: a',
      "$.extra: 'default' is not permitted",
    ]);
  });

  it.each(MODEL_FACING_SCHEMAS)(
    'sends $agent as a strict json_schema the hosted route accepts',
    async ({ agent, schema }): Promise<void> => {
      const request = await captureNativeRequest(agent, schema);
      expect(request.url).toBe('https://api.openai.com/v1/responses');
      expect(request.body.text?.format?.type).toBe('json_schema');
      expect(request.body.text?.format?.strict).toBe(true);
      expect(strictSchemaViolations(request.body.text?.format?.schema)).toEqual([]);
    },
  );
});
