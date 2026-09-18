/** @vitest-environment node */

import type { GenericId } from 'convex/values';
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  compareProviderTs,
  issueProject,
  issueTeamLabels,
  linearCandidate,
  linearListArguments,
  mcpIssuePage,
  runDecisionSweep,
  runIntakeSweep,
  safeIntakeError,
  slackChannelsFromPages,
  type IntakeDependencies,
  type IntakeRuntime,
  type LinearListRequest,
} from '../../convex/intakeActions';
import type { WorkCandidate } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { companyPage } from '../fixtures/company-bed';

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
  decisionPolls: Array<{ surfaceId: Id<'surfaces'>; polledAt?: number; failure?: string }>;
  decisions: unknown[];
  records: RecordedIntake[];
  runtime: IntakeRuntime;
  seeds: Map<string, SeededCandidate>;
  /** Open decision requests per surface id, as the sweep would read them from Convex. */
  openRequests: Map<string, Array<{ ts: string }>>;
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
    ...(surfaceClass === 'chat'
      ? { path: 'documented-api' as const }
      : surfaceClass === 'kanban'
        ? { path: 'mcp' as const }
        : {}),
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
  agents: Doc<'agents'>[] = [agentRow()],
): RuntimeHarness {
  const records: RecordedIntake[] = [];
  const decisionPolls: Array<{
    surfaceId: Id<'surfaces'>;
    polledAt?: number;
    failure?: string;
  }> = [];
  const decisions: unknown[] = [];
  const seeds = new Map<string, SeededCandidate>();
  const openRequests = new Map<string, Array<{ ts: string }>>();
  const runtime: IntakeRuntime = {
    listSurfaces: async (): Promise<Doc<'surfaces'>[]> => surfaces,
    listChatSurfaces: async (): Promise<Doc<'surfaces'>[]> =>
      surfaces.filter((surface: Doc<'surfaces'>): boolean => surface.class === 'chat'),
    getAgent: async (agentId: Id<'agents'>): Promise<Doc<'agents'> | null> =>
      agents.find((agent: Doc<'agents'>): boolean => agent._id === agentId) ?? null,
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
      seeds.set(
        `${String(candidate.agentId)}:${candidate.sourceSystem}:${candidate.externalId}`,
        candidate,
      );
    },
    resolveDecision: async (reply): Promise<void> => {
      decisions.push(reply);
    },
    recordDecisionPoll: async (record): Promise<void> => {
      decisionPolls.push(record);
      const surface = surfaces.find(
        (candidate: Doc<'surfaces'>): boolean => candidate._id === record.surfaceId,
      );
      if (!surface) return;
      if (record.failure !== undefined) {
        surface.lastDecisionError = record.failure;
        return;
      }
      surface.lastDecisionError = undefined;
      if (record.polledAt !== undefined) {
        surface.lastDecisionPolledAt = Math.max(
          surface.lastDecisionPolledAt ?? 0,
          record.polledAt,
        );
      }
    },
    listOpenDecisionRequests: async (surfaceId: Id<'surfaces'>): Promise<Array<{ ts: string }>> =>
      openRequests.get(String(surfaceId)) ?? [],
  };
  return { decisionPolls, decisions, records, runtime, seeds, openRequests };
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

describe('provider timestamp order', (): void => {
  it('keeps microsecond order that a float comparison would round away', (): void => {
    expect(compareProviderTs('1787770800.000001', '1787770800.000002')).toBeLessThan(0);
    expect(compareProviderTs('1787770800.000002', '1787770800.000001')).toBeGreaterThan(0);
    expect(compareProviderTs('1787770800.000100', '1787770800.0001')).toBe(0);
    expect(compareProviderTs('1787770801', '1787770800.999999')).toBeGreaterThan(0);
    expect(compareProviderTs('12.098', '12.100')).toBeLessThan(0);
    expect([...['12.100', '12.098', '12.099']].sort(compareProviderTs)).toEqual([
      '12.098',
      '12.099',
      '12.100',
    ]);
  });
});

describe('real surface intake', (): void => {
  it('hands a batch code reply to the resolver like any single code', async (): Promise<void> => {
    const surface = surfaceRow('slack', 'Slack', 'chat', {
      credentialId: id<'credentials'>('credential-slack'),
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['conversations.list', 'conversations.history'],
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TTEAM',
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
      lastPolledAt: Date.parse('2026-08-26T01:00:00.000Z'),
      lastDecisionPolledAt: Date.parse('2026-08-26T01:04:00.000Z'),
    });
    const harness = runtimeHarness(
      [surface],
      [pageRow('slack.md', 'Slack policy', SLACK)],
      new Map([[String(id<'credentials'>('credential-slack')), 'slack-test-value']]),
    );
    const fetcher = async (): Promise<Response> =>
      slackResponse({
        ok: true,
        messages: [{ ts: '1770000001.000100', user: 'UMANAGER', text: 'approve bq2wxy' }],
        response_metadata: { next_cursor: '' },
      });
    await runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => Date.parse('2026-08-26T01:05:00.000Z'), fetcher });
    expect(harness.decisions).toEqual([
      {
        surfaceId: id<'surfaces'>('surface-slack'),
        userId: 'UMANAGER',
        messageTs: '1770000001.000100',
        reply: { verb: 'approve', id: 'bq2wxy' },
      },
    ]);
  });

  it('polls manager decisions without scanning work channels or advancing discovery', async (): Promise<void> => {
    const discoveryCheckpoint = Date.parse('2026-08-26T01:00:00.000Z');
    const decisionCheckpoint = Date.parse('2026-08-26T01:04:00.000Z');
    const pollTime = Date.parse('2026-08-26T01:05:00.000Z');
    const slackCredential = id<'credentials'>('credential-slack');
    const surface = surfaceRow('slack', 'Slack', 'chat', {
      credentialId: slackCredential,
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['conversations.list', 'conversations.history'],
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TTEAM',
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
      lastPolledAt: discoveryCheckpoint,
      lastDecisionPolledAt: decisionCheckpoint,
    });
    const harness = runtimeHarness(
      // The kanban row is never read: the sweep asks for chat rows only.
      [surface, surfaceRow('linear', 'Linear', 'kanban')],
      [pageRow('slack.md', 'Slack policy', SLACK)],
      new Map([[String(slackCredential), 'slack-test-value']]),
    );
    const calls: URL[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(url);
      return slackResponse({
        ok: true,
        messages: [
          { ts: '1770000001.000100', user: 'UMANAGER', text: 'approve ab3xyz' },
          { ts: '1770000001.000099', user: 'UMANAGER', text: 'reject cd4uvw not now' },
        ],
        response_metadata: { next_cursor: '' },
      });
    };

    await expect(
      runDecisionSweep(harness.runtime, {
        mode: 'real',
        now: (): number => pollTime,
        fetcher,
      }),
    ).resolves.toEqual({ mode: 'real', polled: 1, skipped: 0, surfaces: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe('/api/conversations.history');
    expect(Object.fromEntries(calls[0].searchParams)).toMatchObject({
      channel: 'DMANAGER',
      oldest: String(decisionCheckpoint / 1_000),
      inclusive: 'true',
    });
    expect(harness.decisions).toEqual([
      {
        surfaceId: id<'surfaces'>('surface-slack'),
        userId: 'UMANAGER',
        messageTs: '1770000001.000099',
        reply: { verb: 'reject', id: 'cd4uvw', reason: 'not now' },
      },
      {
        surfaceId: id<'surfaces'>('surface-slack'),
        userId: 'UMANAGER',
        messageTs: '1770000001.000100',
        reply: { verb: 'approve', id: 'ab3xyz' },
      },
    ]);
    expect(harness.decisionPolls).toEqual([
      { surfaceId: id<'surfaces'>('surface-slack'), polledAt: pollTime },
    ]);
    expect(surface.lastPolledAt).toBe(discoveryCheckpoint);
    expect(surface.lastDecisionPolledAt).toBe(pollTime);
    expect(harness.records).toEqual([]);
    expect(harness.seeds.size).toBe(0);
  });

  it('keeps a failed decision poll visible and its checkpoint unmoved', async (): Promise<void> => {
    const decisionCheckpoint = Date.parse('2026-08-26T01:04:00.000Z');
    const pollTime = Date.parse('2026-08-26T01:05:00.000Z');
    const slackCredential = id<'credentials'>('credential-slack');
    const surface = surfaceRow('slack', 'Slack', 'chat', {
      credentialId: slackCredential,
      endpoint: 'https://slack.com/api/',
      // The probe's allowlist lost the one method the decision sweep needs.
      toolAllowlist: ['conversations.list'],
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TTEAM',
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
      lastDecisionPolledAt: decisionCheckpoint,
    });
    const harness = runtimeHarness(
      [surface],
      [],
      new Map([[String(slackCredential), 'slack-test-value']]),
    );
    const fetcher = async (): Promise<Response> => slackResponse({ ok: true, messages: [] });

    await expect(
      runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => pollTime, fetcher }),
    ).resolves.toEqual({ mode: 'real', polled: 0, skipped: 1, surfaces: 1 });
    expect(surface.lastDecisionError).toContain(
      'decision poll failed: Connected Slack surface does not allow conversations.history.',
    );
    expect(surface.lastDecisionPolledAt).toBe(decisionCheckpoint);
    expect(harness.records).toEqual([]);

    surface.toolAllowlist = ['conversations.list', 'conversations.history'];
    const laterPoll = pollTime + 60_000;
    await expect(
      runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => laterPoll, fetcher }),
    ).resolves.toEqual({ mode: 'real', polled: 1, skipped: 0, surfaces: 1 });
    expect(surface.lastDecisionError).toBeUndefined();
    expect(surface.lastDecisionPolledAt).toBe(laterPoll);
  });

  it('clears a stale decision failure once the surface stops being polled', async (): Promise<void> => {
    const surface = surfaceRow('slack', 'Slack', 'chat', {
      verdict: 'listed-dead',
      credentialId: id<'credentials'>('credential-slack'),
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
      lastDecisionError: 'decision poll failed: transport error',
    });
    const harness = runtimeHarness([surface], [], new Map());

    await expect(
      runDecisionSweep(harness.runtime, { mode: 'real' }),
    ).resolves.toMatchObject({ polled: 0, skipped: 1 });
    expect(harness.decisionPolls).toEqual([{ surfaceId: id<'surfaces'>('surface-slack') }]);
    expect(surface.lastDecisionError).toBeUndefined();
  });

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
        managerDmChannelId: 'DMANAGER',
        managerUserId: 'UMANAGER',
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
      if (url.searchParams.get('channel') === 'DMANAGER') {
        return slackResponse({
          ok: true,
          messages: [
            { ts: '1770000001.000100', user: 'UMANAGER', text: 'approve ab3xyz' },
            { ts: '1770000001.000099', user: 'UBOT', text: 'approve ab3xyz' },
            { ts: '1770000001.000098', user: 'UOTHER', text: 'reject cd4uvw not now' },
            { ts: '1770000001.000097', user: 'UMANAGER', text: 'ordinary message' },
            { ts: '1770000001.000096', user: 'UMANAGER', text: 'reject ab3xyz not yet' },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
      return slackResponse({
        ok: true,
        messages: [
          {
            ts: '1770000000.000100',
            thread_ts: '1769999999.000001',
            user: 'USECOND',
            text: '<@UBOT> second channel request',
          },
        ],
        response_metadata: { next_cursor: '' },
      });
    });

    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => pollTime,
      makeMcpClient,
      fetcher: slackFetch,
    });

    expect(result).toEqual({ candidates: 3, mode: 'real', polled: 2, skipped: 2, surfaces: 4 });
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
        updatedAt: '2026-08-26T00:59:59.999Z',
        limit: 100,
      },
      {
        project: 'Q3 close',
        team: 'REVOPS',
        updatedAt: '2026-08-26T00:59:59.999Z',
        limit: 100,
        cursor: 'next-page',
      },
    ]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(harness.seeds.get('agent-intake:linear:issue-1')).toMatchObject({
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'issue-1',
      contentRefs: ['https://linear.app/day0/issue/REVOPS-1'],
      priority: 'High',
      requesterLabel: 'Priya',
    });
    expect(harness.seeds.get('agent-intake:slack:CASKS:1770000000.000100')).toMatchObject({
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      externalId: 'CASKS:1770000000.000100',
      contentSummary: '<@UBOT> please review REVOPS-1',
      contentRefs: ['https://app.slack.com/client/TTEAM/CASKS/thread/CASKS-1770000000000100'],
      requesterLabel: 'UUSER',
      // A reply belongs under the mention itself when it was a top-level message.
      replyTarget: { channel: 'CASKS', channelName: 'revops-asks', threadTs: '1770000000.000100' },
    });
    expect(harness.seeds.get('agent-intake:slack:CREVOPS:1770000000.000100')).toMatchObject({
      externalId: 'CREVOPS:1770000000.000100',
      contentSummary: '<@UBOT> second channel request',
      requesterLabel: 'USECOND',
      // ... and under the parent when the mention was itself a threaded reply.
      replyTarget: { channel: 'CREVOPS', threadTs: '1769999999.000001' },
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
    expect(harness.decisions).toEqual([]);
    expect(
      JSON.stringify({ records: harness.records, seeds: [...harness.seeds.values()] }),
    ).not.toContain('test-value');
  });

  it('reads manager replies through a generic chat MCP history tool', async (): Promise<void> => {
    const credentialId = id<'credentials'>('credential-chat-mcp');
    const harness = runtimeHarness(
      [
        surfaceRow('company-chat', 'Company chat', 'chat', {
          path: 'mcp',
          credentialId,
          endpoint: 'https://chat.example/mcp',
          toolAllowlist: ['conversation_history'],
          managerDmChannelId: 'manager-conversation',
          managerUserId: 'manager-user',
          providerIdentityId: 'agent-bot',
        }),
      ],
      [],
      new Map([[String(credentialId), 'chat-mcp-secret']]),
    );
    const calls: Record<string, unknown>[] = [];
    const disconnect = vi.fn(async (): Promise<void> => undefined);
    const result = await runDecisionSweep(harness.runtime, {
      mode: 'real',
      now: (): number => 12_000,
      makeMcpClient: () => ({
        listToolDefinitionsWithErrors: async () => ({
          definitions: {
            surface: {
              conversation_history: {
                inputSchema: {
                  type: 'object',
                  properties: { conversationId: {}, limit: {}, since: {} },
                },
              },
            },
          },
          errors: {},
        }),
        toolFromDefinition: async () => ({
          execute: async (args: Record<string, unknown>): Promise<unknown> => {
            calls.push(args);
            return {
              messages: [
                { ts: '12.100', user: 'manager-user', text: 'reject gh6npq revise it' },
                { ts: '12.099', user: 'agent-bot', text: 'approve gh6npq' },
                { ts: '12.098', user: 'manager-user', text: 'approve gh6npq' },
              ],
            };
          },
        }),
        disconnect,
      }),
    });

    expect(result).toEqual({ mode: 'real', polled: 1, skipped: 0, surfaces: 1 });
    expect(calls).toEqual([{ conversationId: 'manager-conversation', limit: 100 }]);
    // Providers list newest first; replies resolve in the order the manager sent them,
    // so the first answer wins and the later one is the duplicate.
    expect(harness.decisions).toEqual([
      {
        surfaceId: id<'surfaces'>('surface-company-chat'),
        userId: 'manager-user',
        messageTs: '12.098',
        reply: { verb: 'approve', id: 'gh6npq' },
      },
      {
        surfaceId: id<'surfaces'>('surface-company-chat'),
        userId: 'manager-user',
        messageTs: '12.100',
        reply: { verb: 'reject', id: 'gh6npq', reason: 'revise it' },
      },
    ]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reads a reply the manager left in the thread under the request', async (): Promise<void> => {
    const checkpoint = Date.parse('2026-08-27T02:00:00.000Z');
    const pollAt = Date.parse('2026-08-27T02:05:00.000Z');
    const slackCredential = id<'credentials'>('credential-slack');
    const harness = runtimeHarness(
      [
        surfaceRow('slack', 'Slack', 'chat', {
          credentialId: slackCredential,
          endpoint: 'https://slack.com/api/',
          toolAllowlist: ['conversations.list', 'conversations.history', 'conversations.replies'],
          providerIdentityId: 'UBOT',
          providerWorkspaceId: 'TTEAM',
          managerDmChannelId: 'DMANAGER',
          managerUserId: 'UMANAGER',
          lastPolledAt: checkpoint,
        }),
      ],
      [pageRow('slack.md', 'Slack policy', SLACK)],
      new Map([[String(slackCredential), 'slack-test-value']]),
    );
    const requestTs = '1787770700.000100';
    harness.openRequests.set('surface-slack', [{ ts: requestTs }]);
    const replyCalls: URL[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
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
      if (url.pathname.endsWith('/conversations.replies')) {
        replyCalls.push(url);
        // Slack returns the parent first, then the thread, oldest first.
        return slackResponse({
          ok: true,
          messages: [
            { ts: requestTs, user: 'UBOT', text: 'Priya needs your decision. Reply “approve ab3xyz”', reply_count: 1 },
            { ts: '1787770801.000100', thread_ts: requestTs, user: 'UMANAGER', text: 'approve ab3xyz' },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
      // The top level of the DM shows nothing new: thread replies are not in history.
      return slackResponse({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
    };

    await expect(
      runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => pollAt, fetcher }),
    ).resolves.toMatchObject({ polled: 1 });
    expect(replyCalls).toHaveLength(1);
    expect(Object.fromEntries(replyCalls[0].searchParams)).toMatchObject({
      channel: 'DMANAGER',
      ts: requestTs,
      oldest: String(checkpoint / 1_000),
      inclusive: 'true',
    });
    expect(harness.decisions).toEqual([
      {
        surfaceId: id<'surfaces'>('surface-slack'),
        userId: 'UMANAGER',
        messageTs: '1787770801.000100',
        reply: { verb: 'approve', id: 'ab3xyz' },
      },
    ]);
    expect(JSON.stringify(harness.records)).not.toContain('slack-test-value');
  });

  it('leaves threads alone when nothing is open or the surface cannot read them', async (): Promise<void> => {
    const slackCredential = id<'credentials'>('credential-slack');
    const surface = surfaceRow('slack', 'Slack', 'chat', {
      credentialId: slackCredential,
      endpoint: 'https://slack.com/api/',
      toolAllowlist: ['conversations.list', 'conversations.history'],
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TTEAM',
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
    });
    const harness = runtimeHarness(
      [surface],
      [pageRow('slack.md', 'Slack policy', SLACK)],
      new Map([[String(slackCredential), 'slack-test-value']]),
    );
    harness.openRequests.set('surface-slack', [{ ts: '1787770700.000100' }]);
    const methods: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      methods.push(url.pathname.split('/').pop() ?? '');
      if (url.pathname.endsWith('/conversations.list')) {
        return slackResponse({
          ok: true,
          channels: [{ id: 'CASKS', name: 'revops-asks' }, { id: 'CREVOPS', name: 'revops' }],
          response_metadata: { next_cursor: '' },
        });
      }
      return slackResponse({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
    };

    // Not allowlisted: the top level is still read, the thread is not.
    await runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => 1_000, fetcher });
    expect(methods).not.toContain('conversations.replies');

    // Allowlisted but nothing open: no thread call either.
    surface.toolAllowlist = ['conversations.list', 'conversations.history', 'conversations.replies'];
    harness.openRequests.set('surface-slack', []);
    methods.length = 0;
    await runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => 2_000, fetcher });
    expect(methods).not.toContain('conversations.replies');
    expect(harness.decisions).toEqual([]);
  });

  it('overlaps the chat MCP checkpoint so a reply first visible on the boundary is not missed', async (): Promise<void> => {
    const credentialId = id<'credentials'>('credential-chat-mcp');
    const firstPollAt = Date.parse('2026-08-27T02:00:00.000Z');
    const secondPollAt = Date.parse('2026-08-27T02:05:00.000Z');
    const harness = runtimeHarness(
      [
        surfaceRow('company-chat', 'Company chat', 'chat', {
          path: 'mcp',
          credentialId,
          endpoint: 'https://chat.example/mcp',
          toolAllowlist: ['conversation_history'],
          managerDmChannelId: 'manager-conversation',
          managerUserId: 'manager-user',
          providerIdentityId: 'agent-bot',
        }),
      ],
      [],
      new Map([[String(credentialId), 'chat-mcp-secret']]),
    );
    const calls: Record<string, unknown>[] = [];
    const boundaryTs = `${String(firstPollAt / 1_000)}.000000`;
    const makeMcpClient = () => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: {
            conversation_history: {
              inputSchema: {
                type: 'object',
                properties: { conversationId: {}, limit: {}, oldest: {} },
              },
            },
          },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          calls.push(args);
          // The provider filters strictly after `oldest`; a reply stamped exactly on the
          // first poll's start is only visible when the second poll overlaps it.
          const visible = typeof args.oldest === 'string' && Number(boundaryTs) > Number(args.oldest);
          return {
            messages: visible
              ? [{ ts: boundaryTs, user: 'manager-user', text: 'approve gh6npq' }]
              : [],
          };
        },
      }),
      disconnect: async (): Promise<void> => undefined,
    });

    await expect(
      runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => firstPollAt, makeMcpClient }),
    ).resolves.toMatchObject({ polled: 1 });
    await expect(
      runDecisionSweep(harness.runtime, { mode: 'real', now: (): number => secondPollAt, makeMcpClient }),
    ).resolves.toMatchObject({ polled: 1 });
    expect(calls[1]).toEqual({
      conversationId: 'manager-conversation',
      limit: 100,
      oldest: String((firstPollAt - 1) / 1_000),
    });
    expect(harness.decisions).toEqual([
      {
        surfaceId: id<'surfaces'>('surface-company-chat'),
        userId: 'manager-user',
        messageTs: boundaryTs,
        reply: { verb: 'approve', id: 'gh6npq' },
      },
    ]);
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

  it('skips a browser-driven surface naming the component that is not running', async (): Promise<void> => {
    const tile = surfaceRow('looker-pipeline-tile', 'Looker pipeline tile', 'analytics', {
      path: 'browser-driven',
      endpoint: 'http://looker-tile:8080/',
      credentialId: id<'credentials'>('credential-tile'),
      toolAllowlist: ['browser_navigate', 'browser_snapshot'],
    });
    const harness = runtimeHarness([tile], [], new Map([['credential-tile', 'tile-value']]));
    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => 10_000,
      browserMcpUrl: undefined,
    });
    expect(result).toEqual({ candidates: 0, mode: 'real', polled: 0, skipped: 1, surfaces: 1 });
    expect(harness.records[0].skipReason).toContain('BROWSER_DRIVER_ABSENT');
    expect(harness.records[0].skipReason).toContain('--profile browser');
  });

  it('polls a browser-driven surface by its class once the component is running', async (): Promise<void> => {
    const tile = surfaceRow('looker-pipeline-tile', 'Looker pipeline tile', 'analytics', {
      path: 'browser-driven',
      endpoint: 'http://looker-tile:8080/',
      credentialId: id<'credentials'>('credential-tile'),
      toolAllowlist: ['browser_navigate', 'browser_snapshot'],
    });
    const harness = runtimeHarness([tile], [], new Map([['credential-tile', 'tile-value']]));
    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => 10_000,
      browserMcpUrl: 'http://playwright-mcp:8931/mcp',
    });
    expect(result).toEqual({ candidates: 0, mode: 'real', polled: 0, skipped: 1, surfaces: 1 });
    expect(harness.records[0].skipReason).toBe('no intake reader for connected analytics surface');
  });

  it('names Day0 when a connected kanban surface is not the one it can read', async (): Promise<void> => {
    // The probe admits any documented MCP server now, so a connected kanban
    // surface is no longer necessarily Linear's. Telling the operator their
    // Jira row "is not the approved Linear host" is a claim about their
    // configuration that Day0's own missing reader does not support.
    const jira = surfaceRow('jira', 'Jira', 'kanban', {
      path: 'mcp',
      endpoint: 'https://mcp.jira.example/mcp',
      credentialId: id<'credentials'>('credential-jira'),
      toolAllowlist: ['list_issues'],
    });
    const harness = runtimeHarness([jira], [], new Map([['credential-jira', 'jira-value']]));
    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => 10_000,
      browserMcpUrl: undefined,
    });
    expect(result).toEqual({ candidates: 0, mode: 'real', polled: 0, skipped: 1, surfaces: 1 });
    expect(harness.records[0].skipReason).toBe(
      "no intake reader for Jira; this Day0 deployment reads kanban work through Linear's MCP contract",
    );
    // Named before the credential was decrypted; nothing was dialled.
    expect(harness.records).toHaveLength(1);
  });

  it('makes mock mode a side-effect-free no-op', async (): Promise<void> => {
    const runtime: IntakeRuntime = {
      listSurfaces: vi.fn(async (): Promise<Doc<'surfaces'>[]> => []),
      listChatSurfaces: vi.fn(async (): Promise<Doc<'surfaces'>[]> => []),
      getAgent: vi.fn(),
      listPages: vi.fn(),
      decrypt: vi.fn(),
      recordIntake: vi.fn(),
      recordDecisionPoll: vi.fn(),
      seed: vi.fn(),
      resolveDecision: vi.fn(),
      listOpenDecisionRequests: vi.fn(async (): Promise<Array<{ ts: string }>> => []),
    };
    await expect(runIntakeSweep(runtime, { mode: 'mock' })).resolves.toEqual({
      candidates: 0,
      mode: 'mock',
      polled: 0,
      skipped: 0,
      surfaces: 0,
    });
    expect(runtime.listSurfaces).not.toHaveBeenCalled();

    await expect(runDecisionSweep(runtime, { mode: 'mock' })).resolves.toEqual({
      mode: 'mock',
      polled: 0,
      skipped: 0,
      surfaces: 0,
    });
    expect(runtime.listChatSurfaces).not.toHaveBeenCalled();
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

  it('makes the intake runtime fake preserve the agent part of the deduplication tuple', async (): Promise<void> => {
    const harness = runtimeHarness([], [], new Map());
    const candidate: Omit<SeededCandidate, 'agentId'> = {
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'same-provider-id',
      title: 'Same external issue',
      contentSummary: 'Visible to two different agents.',
      contentRefs: [],
    };

    await harness.runtime.seed({ ...candidate, agentId: id<'agents'>('agent-one') });
    await harness.runtime.seed({ ...candidate, agentId: id<'agents'>('agent-two') });

    expect(harness.seeds.size).toBe(2);
  });
});

describe('intake provider contracts', (): void => {
  it('uses only names exposed by the Linear schema and says which bounds it could not express', (): void => {
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
      args: {
        projectName: 'Q3 close',
        teamKey: 'REVOPS',
        updated_since: '2026-08-26T00:59:59.999Z',
        page_size: 100,
        after: 'cursor-2',
      },
      projectEnforced: true,
      teamEnforced: true,
      checkpointEnforced: true,
    });
    expect(
      linearListArguments(
        { properties: { limit: {} } },
        { project: 'Q3 close' },
        Date.parse('2026-08-26T01:00:00.000Z'),
      ),
    ).toEqual({
      args: { limit: 100 },
      projectEnforced: false,
      teamEnforced: false,
      checkpointEnforced: false,
    });
    expect(
      (): LinearListRequest =>
        linearListArguments(
          { properties: { project: {} } },
          { project: 'Q3 close' },
          undefined,
          'c',
        ),
    ).toThrow('unsupported cursor');
    expect(
      linearListArguments(
        {
          properties: {
            project: {},
            limit: {},
            fields: { type: 'array', items: { type: 'string', enum: ['id', 'title', 'project', 'updatedAt', 'triageIntel'] } },
          },
        },
        { project: 'Q3 close' },
      ).args,
    ).toEqual({ project: 'Q3 close', limit: 100, fields: ['id', 'title', 'updatedAt', 'project'] });
    expect(
      linearListArguments(
        { properties: { project: {}, fields: { type: 'array', items: { type: 'string' } } } },
        { project: 'Q3 close' },
      ).args,
    ).toEqual({ project: 'Q3 close' });
    expect(
      linearListArguments({ properties: { team: {}, project: {}, limit: {} } }, { team: 'FIN' })
        .args,
    ).toEqual({ team: 'FIN', limit: 100 });
    expect(issueTeamLabels({ id: 'FIN-4', team: 'Finance close' })).toEqual([
      'finance close',
      'fin',
    ]);
    expect(issueTeamLabels({ id: 'uuid-1', team: { key: 'LOG', name: 'Logistics desk' } })).toEqual(
      ['log', 'logistics desk'],
    );
    expect(issueTeamLabels({ id: '0d3c5b4e-8f5e-4a0e-9d37-6f1f0b7b9a11' })).toEqual([]);
    expect(issueProject({ project: { name: 'Q3 close', id: 'p1' } })).toBe('Q3 close');
    expect(issueProject({ project: 'Q3 close' })).toBe('Q3 close');
    expect(issueProject({ projectName: 'Q3 close' })).toBe('Q3 close');
    expect(issueProject({ project: { id: 'p1' } })).toBe('p1');
    expect(issueProject({ title: 'no project' })).toBeUndefined();
  });

  it('bounds intake to the documented project itself when the schema cannot', async (): Promise<void> => {
    const linearCredential = id<'credentials'>('credential-linear');
    const surface = surfaceRow('linear', 'Linear', 'kanban', {
      credentialId: linearCredential,
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['list_issues'],
      lastPolledAt: Date.parse('2026-08-26T01:00:00.000Z'),
    });
    const harnessFor = (): ReturnType<typeof runtimeHarness> =>
      runtimeHarness(
        [surface],
        [
          pageRow('onboarding.md', 'Onboarding', ONBOARDING),
          pageRow('linear.md', 'Linear', LINEAR),
        ],
        new Map([[String(linearCredential), 'linear-test-value']]),
      );
    const client = (rows: Record<string, unknown>[]) => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: { surface: { list_issues: { inputSchema: { properties: { limit: {} } } } } },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          expect(args).toEqual({ limit: 100 });
          return { issues: rows };
        },
      }),
      disconnect: async (): Promise<void> => undefined,
    });
    const issue = (
      identifier: string,
      project: unknown,
      updatedAt: string,
    ): Record<string, unknown> => ({
      id: identifier,
      title: `Issue ${identifier}`,
      url: `https://linear.app/day0/issue/${identifier}`,
      updatedAt,
      project,
    });

    const bounded = harnessFor();
    await expect(
      runIntakeSweep(bounded.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        makeMcpClient: () =>
          client([
            issue('in-project', { name: 'Q3 close' }, '2026-08-26T02:00:00.000Z'),
            issue('other-project', { name: 'Q4 plan' }, '2026-08-26T02:00:00.000Z'),
            issue('stale', { name: 'Q3 close' }, '2026-08-26T00:30:00.000Z'),
          ]),
      }),
    ).resolves.toMatchObject({ candidates: 1, polled: 1, skipped: 0 });
    expect([...bounded.seeds.keys()]).toEqual(['agent-intake:linear:in-project']);

    const unbounded = harnessFor();
    await expect(
      runIntakeSweep(unbounded.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        makeMcpClient: () => client([issue('no-project', undefined, '2026-08-26T02:00:00.000Z')]),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 1 });
    expect(unbounded.records[0].skipReason).toContain('cannot be bounded to project Q3 close');
    expect(unbounded.seeds.size).toBe(0);

    const ignoredProviderFilter = runtimeHarness(
      [
        surfaceRow('linear', 'Linear', 'kanban', {
          credentialId: linearCredential,
          endpoint: 'https://mcp.linear.app/mcp',
          toolAllowlist: ['list_issues'],
          lastPolledAt: Date.parse('2026-08-26T01:00:00.000Z'),
        }),
      ],
      [
        pageRow('onboarding.md', 'Onboarding', ONBOARDING),
        pageRow('linear.md', 'Linear', LINEAR),
      ],
      new Map([[String(linearCredential), 'linear-test-value']]),
    );
    await expect(
      runIntakeSweep(ignoredProviderFilter.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        makeMcpClient: () => ({
          listToolDefinitionsWithErrors: async () => ({
            definitions: {
              surface: {
                list_issues: { inputSchema: { properties: { project: {}, limit: {} } } },
              },
            },
            errors: {},
          }),
          toolFromDefinition: async () => ({
            execute: async (): Promise<unknown> => ({
              issues: [
                issue('provider-leak', { name: 'Q4 plan' }, '2026-08-26T02:00:00.000Z'),
              ],
            }),
          }),
          disconnect: async (): Promise<void> => undefined,
        }),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 1, skipped: 0 });
    expect(ignoredProviderFilter.seeds.size).toBe(0);

  });

  it('does not checkpoint or seed a Linear poll whose pagination is incomplete', async (): Promise<void> => {
    const checkpoint = Date.parse('2026-08-26T01:00:00.000Z');
    const linearCredential = id<'credentials'>('credential-linear');
    const makeHarness = (): ReturnType<typeof runtimeHarness> =>
      runtimeHarness(
        [
          surfaceRow('linear', 'Linear', 'kanban', {
            credentialId: linearCredential,
            endpoint: 'https://mcp.linear.app/mcp',
            toolAllowlist: ['list_issues'],
            lastPolledAt: checkpoint,
          }),
        ],
        [
          pageRow('onboarding.md', 'Onboarding', ONBOARDING),
          pageRow('linear.md', 'Linear', LINEAR),
        ],
        new Map([[String(linearCredential), 'linear-test-value']]),
      );
    const client = (nextCursor: (cursor: string | undefined) => string | undefined) => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: {
            list_issues: {
              inputSchema: { properties: { project: {}, updatedAt: {}, cursor: {} } },
            },
          },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (args: Record<string, unknown>): Promise<unknown> => ({
          issues: [
            {
              id: `issue-${String(args.cursor ?? 'first')}`,
              title: 'Provider page row',
              updatedAt: '2026-08-26T02:00:00.000Z',
            },
          ],
          nextCursor: nextCursor(typeof args.cursor === 'string' ? args.cursor : undefined),
        }),
      }),
      disconnect: async (): Promise<void> => undefined,
    });

    const overLimit = makeHarness();
    await expect(
      runIntakeSweep(overLimit.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        makeMcpClient: () =>
          client((cursor) => `page-${cursor ? Number(cursor.replace('page-', '')) + 1 : 1}`),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 1 });
    expect(overLimit.records[0]).toMatchObject({
      skipReason: expect.stringContaining('pagination did not complete'),
    });
    expect(overLimit.records[0].polledAt).toBeUndefined();
    expect(overLimit.seeds.size).toBe(0);

    const cycle = makeHarness();
    await expect(
      runIntakeSweep(cycle.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        makeMcpClient: () => client(() => 'same-page'),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 1 });
    expect(cycle.records[0]).toMatchObject({
      skipReason: expect.stringContaining('repeated a cursor'),
    });
    expect(cycle.records[0].polledAt).toBeUndefined();
    expect(cycle.seeds.size).toBe(0);
  });

  it('does not checkpoint or seed Slack history whose pagination is incomplete', async (): Promise<void> => {
    const slackCredential = id<'credentials'>('credential-slack');
    const makeHarness = (): ReturnType<typeof runtimeHarness> =>
      runtimeHarness(
        [
          surfaceRow('slack', 'Slack', 'chat', {
            credentialId: slackCredential,
            endpoint: 'https://slack.com/api/',
            toolAllowlist: ['conversations.list', 'conversations.history'],
            providerIdentityId: 'UBOT',
            providerWorkspaceId: 'TTEAM',
          }),
        ],
        [pageRow('slack.md', 'Slack policy', SLACK)],
        new Map([[String(slackCredential), 'slack-test-value']]),
      );
    const fetcher =
      (nextCursor: (cursor: string | undefined) => string | undefined) =>
      async (input: string | URL | Request): Promise<Response> => {
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
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const page = cursor ? Number(cursor.replace('page-', '')) + 1 : 1;
        return slackResponse({
          ok: true,
          messages: [
            { ts: `177000000${page}.000100`, user: 'UUSER', text: '<@UBOT> request' },
          ],
          response_metadata: { next_cursor: nextCursor(cursor) },
        });
      };

    const overLimit = makeHarness();
    await expect(
      runIntakeSweep(overLimit.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        fetcher: fetcher(
          (cursor): string =>
            `page-${cursor ? Number(cursor.replace('page-', '')) + 1 : 1}`,
        ),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 1 });
    expect(overLimit.records[0]).toMatchObject({
      skipReason: expect.stringContaining('pagination did not complete'),
    });
    expect(overLimit.records[0].polledAt).toBeUndefined();
    expect(overLimit.seeds.size).toBe(0);

    const cycle = makeHarness();
    await expect(
      runIntakeSweep(cycle.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-08-26T03:00:00.000Z'),
        fetcher: fetcher((): string => 'same-page'),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 1 });
    expect(cycle.records[0]).toMatchObject({
      skipReason: expect.stringContaining('repeated a cursor'),
    });
    expect(cycle.records[0].polledAt).toBeUndefined();
    expect(cycle.seeds.size).toBe(0);
  });

  it('includes the Slack checkpoint boundary when a message appears after the prior snapshot', async (): Promise<void> => {
    const firstPollAt = Date.parse('2026-08-26T02:00:00.000Z');
    const secondPollAt = Date.parse('2026-08-26T03:00:00.000Z');
    const slackCredential = id<'credentials'>('credential-slack');
    const harness = runtimeHarness(
      [
        surfaceRow('slack', 'Slack', 'chat', {
          credentialId: slackCredential,
          endpoint: 'https://slack.com/api/',
          toolAllowlist: ['conversations.list', 'conversations.history'],
          providerIdentityId: 'UBOT',
          providerWorkspaceId: 'TTEAM',
        }),
      ],
      [pageRow('slack.md', 'Slack policy', SLACK)],
      new Map([[String(slackCredential), 'slack-test-value']]),
    );
    const historyUrls: URL[] = [];
    let poll = 0;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/conversations.list')) {
        poll += 1;
        return slackResponse({
          ok: true,
          channels: [
            { id: 'CASKS', name: 'revops-asks' },
            { id: 'CREVOPS', name: 'revops' },
          ],
          response_metadata: { next_cursor: '' },
        });
      }
      historyUrls.push(url);
      const onBoundary =
        poll === 2 &&
        url.searchParams.get('channel') === 'CASKS' &&
        url.searchParams.get('oldest') === String(firstPollAt / 1_000) &&
        url.searchParams.get('inclusive') === 'true';
      return slackResponse({
        ok: true,
        messages: onBoundary
          ? [
              {
                ts: `${String(firstPollAt / 1_000)}.000000`,
                user: 'UUSER',
                text: '<@UBOT> boundary request',
              },
            ]
          : [],
        response_metadata: { next_cursor: '' },
      });
    };

    await expect(
      runIntakeSweep(harness.runtime, {
        mode: 'real',
        now: (): number => firstPollAt,
        fetcher,
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 1 });
    await expect(
      runIntakeSweep(harness.runtime, {
        mode: 'real',
        now: (): number => secondPollAt,
        fetcher,
      }),
    ).resolves.toMatchObject({ candidates: 1, polled: 1 });
    expect([...harness.seeds.keys()]).toEqual([
      `agent-intake:slack:CASKS:${String(firstPollAt / 1_000)}.000000`,
    ]);
    expect(historyUrls.slice(-2).every((url) => url.searchParams.get('inclusive') === 'true')).toBe(
      true,
    );
  });

  it('overlaps a Linear checkpoint so an issue first visible on the timestamp boundary is not missed', async (): Promise<void> => {
    const firstPollAt = Date.parse('2026-08-26T02:00:00.000Z');
    const secondPollAt = Date.parse('2026-08-26T03:00:00.000Z');
    const linearCredential = id<'credentials'>('credential-linear');
    const harness = runtimeHarness(
      [
        surfaceRow('linear', 'Linear', 'kanban', {
          credentialId: linearCredential,
          endpoint: 'https://mcp.linear.app/mcp',
          toolAllowlist: ['list_issues'],
        }),
      ],
      [
        pageRow('onboarding.md', 'Onboarding', ONBOARDING),
        pageRow('linear.md', 'Linear automation', LINEAR),
      ],
      new Map([[String(linearCredential), 'linear-test-value']]),
    );
    const requests: Record<string, unknown>[] = [];
    let poll = 0;
    const makeMcpClient = () => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: {
            list_issues: {
              inputSchema: { properties: { project: {}, updatedAt: {} } },
            },
          },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          requests.push(args);
          poll += 1;
          return poll === 1
            ? { issues: [] }
            : {
                issues: [
                  {
                    id: 'boundary-issue',
                    title: 'Appeared after the prior snapshot',
                    url: 'https://linear.app/day0/issue/REVOPS-boundary',
                    updatedAt: new Date(firstPollAt).toISOString(),
                  },
                ],
              };
        },
      }),
      disconnect: async (): Promise<void> => undefined,
    });

    await expect(
      runIntakeSweep(harness.runtime, {
        mode: 'real',
        now: (): number => firstPollAt,
        makeMcpClient,
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 1 });
    await expect(
      runIntakeSweep(harness.runtime, {
        mode: 'real',
        now: (): number => secondPollAt,
        makeMcpClient,
      }),
    ).resolves.toMatchObject({ candidates: 1, polled: 1 });

    expect(requests).toEqual([
      { project: 'Q3 close' },
      { project: 'Q3 close', updatedAt: '2026-08-26T01:59:59.999Z' },
    ]);
    expect([...harness.seeds.keys()]).toEqual(['agent-intake:linear:boundary-issue']);
  });

  it('maps the shapes Linear\'s live MCP server returns, not only GraphQL-style objects', (): void => {
    const surface = surfaceRow('linear', 'Linear', 'kanban', {
      credentialId: id<'credentials'>('credential-linear'),
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['list_issues'],
    });
    const observedAt = Date.parse('2026-08-26T02:00:00.000Z');
    expect(
      linearCandidate(
        {
          id: 'REVOPS-5',
          title: 'Add the close-summary audit note',
          description: 'Summarise the completed close checks as a comment.',
          priority: { value: 1, name: 'Urgent' },
          url: 'https://linear.app/day00/issue/REVOPS-5/add-the-close-summary-audit-note',
          status: 'Backlog',
          createdBy: 'Brian',
          team: 'RevOps',
        },
        surface,
        observedAt,
      ),
    ).toEqual({
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-5',
      title: 'Add the close-summary audit note',
      contentSummary: 'Summarise the completed close checks as a comment.',
      contentRefs: ['https://linear.app/day00/issue/REVOPS-5/add-the-close-summary-audit-note'],
      observedAt: new Date(observedAt),
      priority: 'Urgent',
      requesterLabel: 'Brian',
      requester: 'Brian',
    });
    const assigneeOnly = linearCandidate(
      { id: 'REVOPS-6', title: 'Reconcile', url: 'https://linear.app/x', assignee: { email: 'a@day0.local' } },
      surface,
      observedAt,
    );
    expect(assigneeOnly).toMatchObject({
      contentSummary: 'Reconcile',
      requesterLabel: 'a@day0.local',
      owner: 'a@day0.local',
      priority: undefined,
    });
    expect(assigneeOnly).not.toHaveProperty('requester');
    expect(linearCandidate({ id: 'REVOPS-7', title: '  ', url: 'https://linear.app/x' }, surface, observedAt)).toBeUndefined();
  });

  it('carries the assignee as the owner and the creator as the requester, each only when the provider returns it', (): void => {
    const surface = surfaceRow('linear', 'Linear', 'kanban', {
      credentialId: id<'credentials'>('credential-linear'),
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['list_issues'],
    });
    const observedAt = Date.parse('2026-09-15T02:00:00.000Z');
    const both = linearCandidate(
      {
        id: 'REVOPS-8',
        title: 'Reconcile the close ledger',
        url: 'https://linear.app/day00/issue/REVOPS-8',
        creator: { name: 'Brian' },
        assignee: { name: 'Ana' },
      },
      surface,
      observedAt,
    );
    expect(both).toMatchObject({ owner: 'Ana', requester: 'Brian', requesterLabel: 'Brian' });

    const neither = linearCandidate(
      { id: 'REVOPS-9', title: 'Unassigned', url: 'https://linear.app/day00/issue/REVOPS-9' },
      surface,
      observedAt,
    );
    expect(neither).not.toHaveProperty('owner');
    expect(neither).not.toHaveProperty('requester');
    expect(neither?.requesterLabel).toBeUndefined();
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

/**
 * One approved scope value quoting its handbook line, as orientation stores it.
 *
 * Args:
 *   value: The team, project or channel name.
 *   ref: The handbook page.
 *   quote: The handbook line that states it.
 *
 * Returns:
 *   A stored scope value.
 */
function scoped(
  value: string,
  ref: string,
  quote: string,
): { value: string; ref: string; quote: string } {
  return { value, ref, quote };
}

describe('each employee reads its own approved queues', (): void => {
  const revopsAgent: Doc<'agents'> = {
    ...agentRow(),
    _id: id<'agents'>('agent-revops'),
    name: 'Priya',
  };
  const financeAgent: Doc<'agents'> = {
    ...agentRow(),
    _id: id<'agents'>('agent-finance'),
    name: 'Mateo',
  };
  const REVOPS_PAGE = companyPage('revops/handbook.md');
  const FINANCE_PAGE = companyPage('finance/handbook.md');
  const LINEAR_PAGE = companyPage('notion-linear-automation');
  const SLACK_PAGE = companyPage('notion-slack-automation-policy');

  /** The company's pages with the two handbooks in one order or the other. */
  function companyPageRows(order: 'revops-first' | 'finance-first'): Doc<'docPages'>[] {
    const handbooks = [REVOPS_PAGE, FINANCE_PAGE];
    return [
      ...(order === 'revops-first' ? handbooks : handbooks.reverse()),
      LINEAR_PAGE,
      SLACK_PAGE,
    ].map((page): Doc<'docPages'> => pageRow(page.ref, page.title, page.markdown));
  }

  /** Two employees' connected Linear and Slack cards, each with its approved scope. */
  function companySurfaces(): Doc<'surfaces'>[] {
    const linear = (
      agent: Doc<'agents'>,
      team: string,
      project: string,
      ref: string,
    ): Doc<'surfaces'> =>
      surfaceRow('linear', 'Linear', 'kanban', {
        _id: id<'surfaces'>(`surface-${agent.name}-linear`),
        agentId: agent._id,
        credentialId: id<'credentials'>(`credential-${agent.name}-linear`),
        endpoint: 'https://mcp.linear.app/mcp',
        toolAllowlist: ['list_issues'],
        intakeScope: {
          team: scoped(team, ref, `- Team: \`${team}\``),
          project: scoped(project, ref, `- Project: \`${project}\``),
        },
      });
    const slack = (
      agent: Doc<'agents'>,
      channels: string[],
      ref: string,
      quote: string,
    ): Doc<'surfaces'> =>
      surfaceRow('slack', 'Slack', 'chat', {
        _id: id<'surfaces'>(`surface-${agent.name}-slack`),
        agentId: agent._id,
        credentialId: id<'credentials'>(`credential-${agent.name}-slack`),
        endpoint: 'https://slack.com/api/',
        toolAllowlist: ['conversations.list', 'conversations.history'],
        providerIdentityId: 'UBOT',
        providerWorkspaceId: 'TKESTREL',
        intakeScope: { channels: channels.map((channel) => scoped(channel, ref, quote)) },
      });
    return [
      linear(revopsAgent, 'REVOPS', 'Q3 close', 'revops/handbook.md'),
      linear(financeAgent, 'FIN', 'September close', 'finance/handbook.md'),
      slack(
        revopsAgent,
        ['revops-asks', 'ops-requests'],
        'revops/handbook.md',
        '- Channels: #revops-asks, #revops, #ops-requests',
      ),
      slack(
        financeAgent,
        ['finance-close', 'ops-requests'],
        'finance/handbook.md',
        '- Channels: #finance-close, #ops-requests',
      ),
    ];
  }

  /** Each credential's decrypted value names its employee and system. */
  function companyCredentials(): Map<string, string> {
    return new Map(
      ['Priya', 'Mateo'].flatMap(
        (name): Array<[string, string]> => [
          [`credential-${name}-linear`, `${name}-linear-value`],
          [`credential-${name}-slack`, `${name}-slack-value`],
        ],
      ),
    );
  }

  it('bounds each list_issues call to its own team and project, whichever handbook comes first', async (): Promise<void> => {
    for (const order of ['revops-first', 'finance-first'] as const) {
      const harness = runtimeHarness(
        companySurfaces(),
        companyPageRows(order),
        companyCredentials(),
        [revopsAgent, financeAgent],
      );
      const calls: Array<{ credential: string; args: Record<string, unknown> }> = [];
      await runIntakeSweep(harness.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-09-18T03:00:00.000Z'),
        fetcher: async (input: string | URL | Request): Promise<Response> =>
          new URL(String(input)).pathname.endsWith('/conversations.list')
            ? slackResponse({ ok: true, channels: [], response_metadata: { next_cursor: '' } })
            : slackResponse({ ok: true, messages: [] }),
        makeMcpClient: (_endpoint: URL, credential: string) => ({
          listToolDefinitionsWithErrors: async () => ({
            definitions: {
              surface: {
                list_issues: { inputSchema: { properties: { team: {}, project: {}, limit: {} } } },
              },
            },
            errors: {},
          }),
          toolFromDefinition: async () => ({
            execute: async (args: Record<string, unknown>): Promise<unknown> => {
              calls.push({ credential, args });
              return { issues: [] };
            },
          }),
          disconnect: async (): Promise<void> => undefined,
        }),
      });
      expect(calls).toEqual([
        {
          credential: 'Priya-linear-value',
          args: { team: 'REVOPS', project: 'Q3 close', limit: 100 },
        },
        {
          credential: 'Mateo-linear-value',
          args: { team: 'FIN', project: 'September close', limit: 100 },
        },
      ]);
    }
  });

  it('polls both projects approved on one finance card and keeps the provider ids', async (): Promise<void> => {
    const finance = companySurfaces()[1];
    const second = scoped('October close', 'finance/handbook.md', '- Project: `October close`');
    const surface: Doc<'surfaces'> = {
      ...finance,
      intakeScope: { ...finance.intakeScope, projects: [second] },
    };
    const harness = runtimeHarness(
      [surface],
      companyPageRows('revops-first'),
      companyCredentials(),
      [financeAgent],
    );
    const calls: string[] = [];
    await expect(runIntakeSweep(harness.runtime, {
      mode: 'real',
      makeMcpClient: () => ({
        listToolDefinitionsWithErrors: async () => ({
          definitions: { surface: { list_issues: { inputSchema: { properties: { team: {}, project: {} } } } } },
          errors: {},
        }),
        toolFromDefinition: async () => ({
          execute: async (args: Record<string, unknown>): Promise<unknown> => {
            const project = String(args.project);
            calls.push(project);
            return { issues: [{
              id: project === 'September close' ? 'FIN-1' : 'FIN-2',
              title: `Ticket in ${project}`,
              url: 'https://linear.app/kestrel/issue/fin',
              project: { name: project },
            }] };
          },
        }),
        disconnect: async (): Promise<void> => undefined,
      }),
    })).resolves.toMatchObject({ candidates: 2, polled: 1 });
    expect(calls).toEqual(['September close', 'October close']);
    expect([...harness.seeds.values()].map((seed) => [seed.sourceSystem, seed.externalId])).toEqual([
      ['linear', 'FIN-1'],
      ['linear', 'FIN-2'],
    ]);
  });

  it('reads only the approved channels, so finance never reads #revops-asks', async (): Promise<void> => {
    for (const order of ['revops-first', 'finance-first'] as const) {
      const harness = runtimeHarness(
        companySurfaces(),
        companyPageRows(order),
        companyCredentials(),
        [revopsAgent, financeAgent],
      );
      const history: Array<{ credential: string; channel: string }> = [];
      const ids: Record<string, string> = {
        'revops-asks': 'CASKS',
        revops: 'CREVOPS',
        'ops-requests': 'COPS',
        'finance-close': 'CFIN',
        'logistics-desk': 'CLOG',
      };
      await runIntakeSweep(harness.runtime, {
        mode: 'real',
        now: (): number => Date.parse('2026-09-18T03:00:00.000Z'),
        fetcher: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(String(input));
          if (url.pathname.endsWith('/conversations.list')) {
            return slackResponse({
              ok: true,
              channels: Object.entries(ids).map(([name, channel]) => ({ id: channel, name })),
              response_metadata: { next_cursor: '' },
            });
          }
          const credential = String(new Headers(init?.headers).get('Authorization')).replace(
            'Bearer ',
            '',
          );
          history.push({ credential, channel: url.searchParams.get('channel') ?? '' });
          return slackResponse({
            ok: true,
            messages: [
              {
                ts: '1770000000.000100',
                user: 'UASKER',
                text: `<@UBOT> ask in ${url.searchParams.get('channel')}`,
              },
            ],
          });
        },
        makeMcpClient: () => ({
          listToolDefinitionsWithErrors: async () => ({
            definitions: {
              surface: { list_issues: { inputSchema: { properties: { team: {}, project: {} } } } },
            },
            errors: {},
          }),
          toolFromDefinition: async () => ({
            execute: async (): Promise<unknown> => ({ issues: [] }),
          }),
          disconnect: async (): Promise<void> => undefined,
        }),
      });
      expect(
        history
          .filter((call) => call.credential === 'Mateo-slack-value')
          .map((call) => call.channel),
      ).toEqual(['CFIN', 'COPS']);
      expect(
        history
          .filter((call) => call.credential === 'Priya-slack-value')
          .map((call) => call.channel),
      ).toEqual(['CASKS', 'COPS']);
      expect(
        [...harness.seeds.values()]
          .filter((seed) => seed.agentId === financeAgent._id)
          .map((seed) => seed.replyTarget?.channelName),
      ).toEqual(['finance-close', 'ops-requests']);
    }
  });

  it('reads nothing from an empty approved scope and says why, before any credential is used', async (): Promise<void> => {
    const surfaces = companySurfaces().map(
      (surface): Doc<'surfaces'> => ({ ...surface, intakeScope: {} }),
    );
    const decrypted: string[] = [];
    const harness = runtimeHarness(
      surfaces,
      companyPageRows('revops-first'),
      companyCredentials(),
      [revopsAgent, financeAgent],
    );
    const decrypt = harness.runtime.decrypt;
    harness.runtime.decrypt = async (credentialId): Promise<string> => {
      decrypted.push(String(credentialId));
      return await decrypt(credentialId);
    };
    await expect(
      runIntakeSweep(harness.runtime, {
        mode: 'real',
        fetcher: async (): Promise<Response> => {
          throw new Error('no provider call expected');
        },
        makeMcpClient: () => {
          throw new Error('no provider call expected');
        },
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 4 });
    expect(decrypted).toEqual([]);
    expect(harness.records.map((record) => record.skipReason)).toEqual([
      'Reads nothing from Linear: no documented team or project was picked for this role.',
      'Reads nothing from Slack: no documented channel was picked for this role.',
      'Reads nothing from Linear: no documented team or project was picked for this role.',
      'Reads nothing from Slack: no documented channel was picked for this role.',
    ]);
  });

  it('bounds intake to the approved team itself when the schema takes no team argument', async (): Promise<void> => {
    const finance = companySurfaces()[1];
    const issue = (identifier: string, team: unknown): Record<string, unknown> => ({
      id: identifier,
      title: `Issue ${identifier}`,
      url: `https://linear.app/kestrel/issue/${identifier}`,
      project: { name: 'September close' },
      ...(team === undefined ? {} : { team }),
    });
    const client = (rows: Record<string, unknown>[]) => () => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: { list_issues: { inputSchema: { properties: { project: {}, limit: {} } } } },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (args: Record<string, unknown>): Promise<unknown> => {
          expect(args).toEqual({ project: 'September close', limit: 100 });
          return { issues: rows };
        },
      }),
      disconnect: async (): Promise<void> => undefined,
    });

    const bounded = runtimeHarness(
      [finance],
      companyPageRows('revops-first'),
      companyCredentials(),
      [financeAgent],
    );
    await expect(
      runIntakeSweep(bounded.runtime, {
        mode: 'real',
        makeMcpClient: client([
          issue('FIN-4', 'Finance close'),
          issue('REVOPS-5', 'Revenue operations'),
          issue('uuid-1', { key: 'FIN', name: 'Finance close' }),
          issue('uuid-2', { key: 'LOG', name: 'Logistics desk' }),
          issue('uuid-without-team', undefined),
          { ...issue('uuid-without-project', 'Finance close'), project: undefined },
        ]),
      }),
    ).resolves.toMatchObject({ candidates: 2, polled: 1 });
    expect([...bounded.seeds.values()].map((seed) => seed.externalId)).toEqual(['FIN-4', 'uuid-1']);

    const unbounded = runtimeHarness(
      [finance],
      companyPageRows('revops-first'),
      companyCredentials(),
      [financeAgent],
    );
    await expect(
      runIntakeSweep(unbounded.runtime, {
        mode: 'real',
        makeMcpClient: client([issue('uuid-3', undefined)]),
      }),
    ).resolves.toMatchObject({ candidates: 0, polled: 0, skipped: 1 });
    expect(unbounded.records[0].skipReason).toContain('cannot be bounded to team FIN');
  });
});

describe('poll on connect', (): void => {
  /** Two connected surfaces; only Linear has a reader wired for this test. */
  function connectedPair(): {
    harness: RuntimeHarness;
    makeMcpClient: NonNullable<IntakeDependencies['makeMcpClient']>;
  } {
    const linearCredential = id<'credentials'>('cred-linear');
    const slackCredential = id<'credentials'>('cred-slack');
    const surfaces = [
      surfaceRow('slack', 'Slack', 'chat', {
        credentialId: slackCredential,
        endpoint: 'https://slack.com/api/',
        providerIdentityId: 'UBOT',
        providerWorkspaceId: 'TTEAM',
      }),
      surfaceRow('linear', 'Linear', 'kanban', {
        credentialId: linearCredential,
        endpoint: 'https://mcp.linear.app/mcp',
        toolAllowlist: ['list_issues'],
      }),
    ];
    const pages = [pageRow('onboarding.md', 'Onboarding', ONBOARDING), pageRow('linear.md', 'Linear', LINEAR)];
    const harness = runtimeHarness(
      surfaces,
      pages,
      new Map([
        [String(linearCredential), 'linear-test-value'],
        [String(slackCredential), 'slack-test-value'],
      ]),
    );
    const makeMcpClient = () => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: {
            list_issues: {
              inputSchema: { type: 'object', properties: { project: {}, team: {}, limit: {} } },
            },
          },
        },
        errors: {},
      }),
      toolFromDefinition: async () => ({
        execute: async (): Promise<unknown> => ({
          issues: [
            {
              id: 'issue-9',
              title: 'Reconcile the close checklist',
              description: 'Reconcile the checklist against the ledger.',
              url: 'https://linear.app/day0/issue/REVOPS-9',
              updatedAt: '2026-09-15T01:30:00.000Z',
            },
          ],
        }),
      }),
      disconnect: async (): Promise<void> => undefined,
    });
    return { harness, makeMcpClient };
  }

  it('polls only the surface that connected and records nothing for the others', async (): Promise<void> => {
    const { harness, makeMcpClient } = connectedPair();
    const fetcher = vi.fn(async (): Promise<Response> => {
      throw new Error('the chat surface must not be polled by a Linear connection');
    });

    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      now: (): number => Date.parse('2026-09-15T02:00:00.000Z'),
      surfaceId: id<'surfaces'>('surface-linear'),
      makeMcpClient,
      fetcher,
    });

    expect(result).toEqual({ candidates: 1, mode: 'real', polled: 1, skipped: 0, surfaces: 1 });
    expect(harness.records).toEqual([
      {
        surfaceId: id<'surfaces'>('surface-linear'),
        waterfallPosition: 1,
        polledAt: Date.parse('2026-09-15T02:00:00.000Z'),
      },
    ]);
    expect([...harness.seeds.keys()]).toEqual(['agent-intake:linear:issue-9']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('polls nothing when the surface is unknown', async (): Promise<void> => {
    const { harness, makeMcpClient } = connectedPair();

    const result = await runIntakeSweep(harness.runtime, {
      mode: 'real',
      surfaceId: id<'surfaces'>('surface-missing'),
      makeMcpClient,
    });

    expect(result).toEqual({ candidates: 0, mode: 'real', polled: 0, skipped: 0, surfaces: 0 });
    expect(harness.records).toEqual([]);
  });
});
