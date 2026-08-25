/** @vitest-environment node */

import type { GenericId } from 'convex/values';
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  linearListArguments,
  mcpIssuePage,
  runIntakeSweep,
  safeIntakeError,
  slackChannelsFromPages,
  type IntakeRuntime,
} from '../../convex/intakeActions';
import type { WorkCandidate } from '../../src/work/types';
import { allConvexModules } from './all-modules';

type CredentialId = GenericId<'credentials'>;

interface RecordedIntake {
  surfaceId: Id<'surfaces'>;
  waterfallPosition: number;
  skipReason?: string;
  polledAt?: number;
}

interface SeededCandidate extends Omit<WorkCandidate, 'observedAt'> {
  agentId: Id<'agents'>;
}

interface RuntimeHarness {
  records: RecordedIntake[];
  runtime: IntakeRuntime;
  seeds: Map<string, SeededCandidate>;
}

/**
 * Build a typed Convex id for an in-memory intake test.
 *
 * Args:
 *   value: Readable test identifier.
 *
 * Returns:
 *   A branded Convex id.
 */
function id<TableName extends string>(value: string): GenericId<TableName> {
  return value as GenericId<TableName>;
}

/**
 * Build the owning agent used by one intake sweep.
 *
 * Returns:
 *   An active, owner-linked agent row.
 */
function agentRow(): Doc<'agents'> {
  return {
    _id: id<'agents'>('agent-intake'),
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Intake test agent',
    state: 'active',
    userId: 'owner',
    createdAt: 1,
  };
}

/**
 * Build one redacted documentation page.
 *
 * Args:
 *   ref: Stable page reference.
 *   title: Page title.
 *   markdown: Redacted Markdown content.
 *
 * Returns:
 *   A documentation page row.
 */
function pageRow(ref: string, title: string, markdown: string): Doc<'docPages'> {
  return {
    _id: id<'docPages'>(`page-${ref}`),
    _creationTime: 1,
    sourceId: id<'docSources'>('source-intake'),
    ref,
    title,
    markdown,
    updatedAt: 1,
  };
}

/**
 * Build one surface with safe defaults for an intake test.
 *
 * Args:
 *   slug: Surface identifier.
 *   displayName: Documented system name.
 *   surfaceClass: Charter surface class.
 *   patch: Test-specific fields.
 *
 * Returns:
 *   A persisted surface row.
 */
function surfaceRow(
  slug: string,
  displayName: string,
  surfaceClass: string,
  patch: Partial<Doc<'surfaces'>> = {},
): Doc<'surfaces'> {
  return {
    _id: id<'surfaces'>(`surface-${slug}`),
    _creationTime: 1,
    agentId: id<'agents'>('agent-intake'),
    slug,
    displayName,
    class: surfaceClass,
    verdict: 'connected',
    whereFound: [],
    credentialLanded: true,
    createdAt: 1,
    ...patch,
  };
}

/**
 * Create an in-memory runtime that mirrors seedItem's deduplication key.
 *
 * Args:
 *   surfaces: Mutable surface rows returned to the sweep.
 *   pages: Agent documentation pages.
 *   credentials: Decrypted test values keyed by credential id.
 *
 * Returns:
 *   Runtime plus observable records and deduplicated seeds.
 */
function runtimeHarness(
  surfaces: Doc<'surfaces'>[],
  pages: Doc<'docPages'>[],
  credentials: Map<string, string>,
): RuntimeHarness {
  const records: RecordedIntake[] = [];
  const seeds = new Map<string, SeededCandidate>();
  const agent = agentRow();
  const runtime: IntakeRuntime = {
    listSurfaces: async (): Promise<Doc<'surfaces'>[]> => surfaces,
    getAgent: async (agentId: Id<'agents'>): Promise<Doc<'agents'> | null> =>
      agentId === agent._id ? agent : null,
    listPages: async (): Promise<Doc<'docPages'>[]> => pages,
    decrypt: async (credentialId: CredentialId): Promise<string> => {
      const value = credentials.get(String(credentialId));
      if (!value) throw new Error('credential unavailable');
      return value;
    },
    recordIntake: async (record: RecordedIntake): Promise<void> => {
      records.push(record);
      const surface = surfaces.find(
        (candidate: Doc<'surfaces'>): boolean => candidate._id === record.surfaceId,
      );
      if (surface && record.polledAt !== undefined) surface.lastPolledAt = record.polledAt;
    },
    seed: async (candidate: SeededCandidate): Promise<void> => {
      seeds.set(`${candidate.sourceSystem}:${candidate.externalId}`, candidate);
    },
  };
  return { records, runtime, seeds };
}

const ONBOARDING = [
  '# Revenue operations onboarding',
  '',
  '## Systems and access owners',
  '',
  '| System | Use | Owner |',
  '|---|---|---|',
  '| Linear | Work queue | IT |',
  '| Slack | Requests | Messaging |',
  '| Northstar CRM | Records | Business systems |',
  '| Team documentation | Runbooks | Manager |',
].join('\n');

const LINEAR = [
  '# Linear automation',
  '- Team: `RevOps`, identifier `REVOPS`.',
  '- Project: `Q3 close`.',
].join('\n');

const SLACK = [
  '# Slack automation policy',
  '- Channels: `#revops-asks` (inbound requests), `#revops` (team channel).',
].join('\n');

/**
 * Return a successful JSON response for a Slack test payload.
 *
 * Args:
 *   payload: Slack Web API response body.
 *
 * Returns:
 *   HTTP 200 JSON response.
 */
function slackResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('real surface intake', (): void => {
  it('walks the documented waterfall, checkpoints successes, and maps Linear and Slack work', async (): Promise<void> => {
    const checkpoint = Date.parse('2026-08-26T01:00:00.000Z');
    const pollTime = Date.parse('2026-08-26T02:00:00.000Z');
    const linearCredential = id<'credentials'>('credential-linear');
    const slackCredential = id<'credentials'>('credential-slack');
    const surfaces = [
      surfaceRow('team-documentation', 'Team documentation', 'docs', {
        credentialId: id<'credentials'>('credential-docs'),
      }),
      surfaceRow('slack', 'Slack', 'chat', {
        credentialId: slackCredential,
        endpoint: 'https://slack.com/api/',
        toolAllowlist: ['conversations.list', 'conversations.history'],
        providerIdentityId: 'UBOT',
        providerWorkspaceId: 'TTEAM',
        lastPolledAt: checkpoint,
      }),
      surfaceRow('northstar-crm', 'Northstar CRM', 'crm', {
        verdict: 'absent',
        credentialLanded: false,
        reason: 'No approved surface found after searching: Northstar CRM, crm',
      }),
      surfaceRow('linear', 'Linear', 'kanban', {
        credentialId: linearCredential,
        endpoint: 'https://mcp.linear.app/mcp',
        toolAllowlist: ['list_issues'],
        lastPolledAt: checkpoint,
      }),
    ];
    const pages = [
      pageRow('slack.md', 'Slack policy', SLACK),
      pageRow('onboarding.md', 'Onboarding', ONBOARDING),
      pageRow('linear.md', 'Linear automation', LINEAR),
    ];
    const harness = runtimeHarness(
      surfaces,
      pages,
      new Map([
        [String(linearCredential), 'linear-test-value'],
        [String(slackCredential), 'slack-test-value'],
      ]),
    );
    const mcpCalls: Record<string, unknown>[] = [];
    const disconnect = vi.fn(async (): Promise<void> => undefined);
    const makeMcpClient = (): {
      listToolDefinitionsWithErrors(): Promise<{
        definitions: Record<string, Record<string, { inputSchema: unknown }>>;
        errors: Record<string, string>;
      }>;
      toolFromDefinition(): Promise<{
        execute(args: Record<string, unknown>): Promise<unknown>;
      }>;
      disconnect(): Promise<void>;
    } => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: {
            list_issues: {
              inputSchema: {
                type: 'object',
                properties: { project: {}, team: {}, updatedAt: {}, limit: {}, cursor: {} },
              },
            },
          },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          mcpCalls.push(args);
          if (!args.cursor) {
            return {
              issues: [
                {
                  id: 'issue-1',
                  title: 'Prepare close update',
                  description: 'Draft the Q3 close status for the manager.',
                  url: 'https://linear.app/day0/issue/REVOPS-1',
                  updatedAt: '2026-08-26T01:30:00.000Z',
                  priority: { label: 'High' },
                  creator: { name: 'Priya' },
                },
              ],
              nextCursor: 'next-page',
            };
          }
          return { issues: [] };
        },
      }),
      disconnect,
    });
    const slackFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/conversations.list')) {
        return slackResponse({
          ok: true,
          channels: [
            { id: 'CASKS', name: 'revops-asks' },
            { id: 'CREVOPS', name: 'revops' },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
      if (url.searchParams.get('channel') === 'CASKS') {
        return slackResponse({
          ok: true,
          messages: [
            { ts: '1770000000.000100', user: 'UUSER', text: '<@UBOT> please review REVOPS-1' },
            { ts: '1770000000.000099', user: 'UOTHER', text: 'No mention here' },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
      return slackResponse({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
    });

    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => pollTime,
      makeMcpClient,
      fetcher: slackFetch,
    });

    expect(result).toEqual({ candidates: 2, mode: 'real', polled: 2, skipped: 2, surfaces: 4 });
    expect(
      harness.records.map((record): [string, number] => [
        String(record.surfaceId),
        record.waterfallPosition,
      ]),
    ).toEqual([
      [String(id<'surfaces'>('surface-linear')), 1],
      [String(id<'surfaces'>('surface-slack')), 2],
      [String(id<'surfaces'>('surface-northstar-crm')), 3],
      [String(id<'surfaces'>('surface-team-documentation')), 4],
    ]);
    expect(harness.records.slice(0, 2)).toEqual([
      { surfaceId: id<'surfaces'>('surface-linear'), waterfallPosition: 1, polledAt: pollTime },
      { surfaceId: id<'surfaces'>('surface-slack'), waterfallPosition: 2, polledAt: pollTime },
    ]);
    expect(harness.records[2].skipReason).toContain('No approved surface');
    expect(harness.records[3].skipReason).toBe('no intake reader for connected docs surface');
    expect(mcpCalls).toEqual([
      {
        project: 'Q3 close',
        team: 'REVOPS',
        updatedAt: '2026-08-26T01:00:00.000Z',
        limit: 100,
      },
      {
        project: 'Q3 close',
        team: 'REVOPS',
        updatedAt: '2026-08-26T01:00:00.000Z',
        limit: 100,
        cursor: 'next-page',
      },
    ]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(harness.seeds.get('linear:issue-1')).toMatchObject({
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'issue-1',
      contentRefs: ['https://linear.app/day0/issue/REVOPS-1'],
      priority: 'High',
      requesterLabel: 'Priya',
    });
    expect(harness.seeds.get('slack:1770000000.000100')).toMatchObject({
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      externalId: '1770000000.000100',
      contentSummary: '<@UBOT> please review REVOPS-1',
      contentRefs: ['https://app.slack.com/client/TTEAM/CASKS/thread/CASKS-1770000000000100'],
      requesterLabel: 'UUSER',
    });
    const historyUrls = slackFetch.mock.calls
      .map(([input]): URL => new URL(String(input)))
      .filter((url: URL): boolean => url.pathname.endsWith('/conversations.history'));
    expect(historyUrls).toHaveLength(2);
    expect(
      historyUrls.every(
        (url: URL): boolean => url.searchParams.get('oldest') === String(checkpoint / 1_000),
      ),
    ).toBe(true);
    expect(
      JSON.stringify({ records: harness.records, seeds: [...harness.seeds.values()] }),
    ).not.toContain('test-value');
  });

  it('contains one provider failure, redacts its credential, and continues to the next surface', async (): Promise<void> => {
    const linearCredential = id<'credentials'>('credential-linear');
    const slackCredential = id<'credentials'>('credential-slack');
    const surfaces = [
      surfaceRow('linear', 'Linear', 'kanban', {
        credentialId: linearCredential,
        endpoint: 'https://mcp.linear.app/mcp',
        toolAllowlist: ['list_issues'],
      }),
      surfaceRow('slack', 'Slack', 'chat', {
        credentialId: slackCredential,
        toolAllowlist: ['conversations.list', 'conversations.history'],
        providerIdentityId: 'UBOT',
        providerWorkspaceId: 'TTEAM',
      }),
    ];
    const linearToken = ['lin', 'api', 'privatevalue'].join('_');
    const slackToken = ['xoxb', 'privatevalue'].join('-');
    const harness = runtimeHarness(
      surfaces,
      [
        pageRow('onboarding.md', 'Onboarding', ONBOARDING),
        pageRow('linear.md', 'Linear', LINEAR),
        pageRow('slack.md', 'Slack', SLACK),
      ],
      new Map([
        [String(linearCredential), linearToken],
        [String(slackCredential), slackToken],
      ]),
    );
    const makeMcpClient = (): {
      listToolDefinitionsWithErrors(): Promise<{
        definitions: Record<string, Record<string, { inputSchema: unknown }>>;
        errors: Record<string, string>;
      }>;
      toolFromDefinition(): Promise<{ execute(): Promise<never> }>;
      disconnect(): Promise<void>;
    } => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: {
            list_issues: { inputSchema: { properties: { project: {}, limit: {} } } },
          },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (): Promise<never> => {
          throw new Error(`401 for Bearer ${linearToken}`);
        },
      }),
      disconnect: async (): Promise<void> => undefined,
    });
    const slackFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/conversations.list')) {
        return slackResponse({
          ok: true,
          channels: [
            { id: 'CASKS', name: 'revops-asks' },
            { id: 'CREVOPS', name: 'revops' },
          ],
        });
      }
      return slackResponse({ ok: true, messages: [] });
    });

    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => 10_000,
      makeMcpClient,
      fetcher: slackFetch,
    });

    expect(result).toEqual({ candidates: 0, mode: 'real', polled: 1, skipped: 1, surfaces: 2 });
    expect(harness.records[0].skipReason).toBe('intake failed: 401 for Bearer <redacted>');
    expect(harness.records[1]).toMatchObject({
      surfaceId: id<'surfaces'>('surface-slack'),
      waterfallPosition: 2,
      polledAt: 10_000,
    });
    expect(JSON.stringify(harness.records)).not.toContain('privatevalue');
  });

  it('makes mock mode a side-effect-free no-op', async (): Promise<void> => {
    const runtime: IntakeRuntime = {
      listSurfaces: vi.fn(async (): Promise<Doc<'surfaces'>[]> => []),
      getAgent: vi.fn(),
      listPages: vi.fn(),
      decrypt: vi.fn(),
      recordIntake: vi.fn(),
      seed: vi.fn(),
    };
    await expect(runIntakeSweep(runtime, { mode: 'mock' })).resolves.toEqual({
      candidates: 0,
      mode: 'mock',
      polled: 0,
      skipped: 0,
      surfaces: 0,
    });
    expect(runtime.listSurfaces).not.toHaveBeenCalled();
  });

  it('relies on seedItem to deduplicate repeated provider identities', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Dedup test agent',
          state: 'active',
          createdAt: 1,
        }),
    );
    const candidate = {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'issue-stable-id',
      title: 'First observed title',
      contentSummary: 'First provider body.',
      contentRefs: ['https://linear.app/day0/issue/REVOPS-1'],
    };
    const first = await harness.mutation(internal.work.seedItem, candidate);
    const second = await harness.mutation(internal.work.seedItem, {
      ...candidate,
      title: 'Changed provider title',
    });
    const rows = await harness.run(
      async (ctx): Promise<Doc<'workItems'>[]> => await ctx.db.query('workItems').collect(),
    );

    expect(second).toBe(first);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: first,
      sourceSystem: 'linear',
      externalId: 'issue-stable-id',
      title: 'First observed title',
    });
  });
});

describe('intake provider contracts', (): void => {
  it('uses only names exposed by the Linear schema and refuses an unbounded checkpoint', (): void => {
    expect(
      linearListArguments(
        {
          properties: {
            projectName: {},
            teamKey: {},
            updated_since: {},
            page_size: {},
            after: {},
          },
        },
        { project: 'Q3 close', team: 'REVOPS' },
        Date.parse('2026-08-26T01:00:00.000Z'),
        'cursor-2',
      ),
    ).toEqual({
      projectName: 'Q3 close',
      teamKey: 'REVOPS',
      updated_since: '2026-08-26T01:00:00.000Z',
      page_size: 100,
      after: 'cursor-2',
    });
    expect(
      (): Record<string, unknown> =>
        linearListArguments(
          { properties: { project: {} } },
          { project: 'Q3 close' },
          Date.parse('2026-08-26T01:00:00.000Z'),
        ),
    ).toThrow('no supported updated-at argument');
  });

  it('decodes structured and text MCP results and reads only policy channel rows', (): void => {
    expect(
      mcpIssuePage({ structuredContent: { issues: [{ id: 'one' }], nextCursor: 'two' } }),
    ).toEqual({
      issues: [{ id: 'one' }],
      nextCursor: 'two',
    });
    expect(
      mcpIssuePage({ content: [{ type: 'text', text: '```json\n[{"id":"three"}]\n```' }] }),
    ).toEqual({ issues: [{ id: 'three' }] });
    expect(
      slackChannelsFromPages([
        pageRow('slack.md', 'Slack policy', SLACK),
        pageRow('other.md', 'Other', 'Mention #not-a-policy-channel in prose.'),
      ]),
    ).toEqual(['revops-asks', 'revops']);
  });

  it('redacts exact and token-shaped credentials from bounded errors', (): void => {
    const tokenShape = ['xoxb', 'another-private-value'].join('-');
    const safe = safeIntakeError(
      new Error(`Bearer custom-value failed next to ${tokenShape}`),
      'custom-value',
    );
    expect(safe).toBe('Bearer <redacted> failed next to <redacted>');
  });
});
