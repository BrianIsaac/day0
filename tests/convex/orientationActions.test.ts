/** @vitest-environment node */

import { readFileSync } from 'node:fs';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  attributedUrls,
  choosePath,
  documentedEndpoints,
  evidenceLine,
  extractCredentialFinding,
  explicitlyDeniesSurface,
  registryRemoteEndpoint,
  relevantSystemText,
} from '../../convex/orientationActions';
import { allConvexModules } from './all-modules';
import {
  fakeCredentialState,
  resetFakeCredentials,
  seedFakeCredential,
} from './fakes/credential-registry';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

type DraftPath = 'mcp' | 'documented-api' | 'browser-driven' | 'escalate';

/** Read a sanitised copy of one submitted Notion page. */
function notionFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/notion-pages/${name}.md`, import.meta.url), 'utf8');
}

/** Load the deployment with a contract-level Lane A credential store. */
function orientationModules(): Record<string, () => Promise<unknown>> {
  return {
    ...allConvexModules(),
    '../../convex/credentials.ts': async (): Promise<
      typeof import('./fakes/credentials')
    > => await import('./fakes/credentials'),
  };
}

const model = vi.hoisted(() => ({
  /** Path the mocked classifier proposes per system; unset means the model fails. */
  pathFor: undefined as undefined | ((system: string) => DraftPath),
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async ({ user }: { user: string }): Promise<Record<string, unknown>> => {
    if (!model.pathFor) throw new Error('model unavailable in tests');
    const system = /^System: (.+)$/m.exec(user)?.[1] ?? '';
    return {
      path: model.pathFor(system),
      fallbackPath: 'escalate',
      confidence: 0.9,
      reasoning: `Model draft for ${system}.`,
      scopeRequested: [],
      credential: { found: 'none', method: 'unknown' },
      blastRadius: 'One system.',
      costBand: 'none',
      expiresInDays: 30,
      rollback: 'Reject the surface.',
      openQuestions: [],
    };
  },
  agentText: async (): Promise<string> => '',
}));

const REGISTRY_SERVERS = {
  linear: {
    server: {
      name: 'app.linear/linear',
      title: 'Linear',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
    },
  },
  slack: {
    server: {
      name: 'ai.smithery/smithery-ai-slack',
      title: 'Slack',
      description: 'Community Slack gateway',
      remotes: [
        { type: 'streamable-http', url: 'https://server.smithery.ai/@smithery-ai/slack/mcp' },
      ],
    },
  },
  northstar: {
    server: {
      name: 'com.example/northstar-crm',
      title: 'Northstar CRM connector',
      remotes: [{ type: 'streamable-http', url: 'https://community.example/northstar/mcp' }],
    },
  },
};

/**
 * Stub the public MCP Registry so no test reaches the network.
 *
 * Returns:
 *   The fetch mock, for asserting which searches ran.
 */
function stubRegistry(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: URL | string): Promise<Response> => {
    const search = new URL(String(input)).searchParams.get('search')?.toLowerCase() ?? '';
    const servers = Object.values(REGISTRY_SERVERS).filter((entry): boolean =>
      `${entry.server.name} ${entry.server.title}`.toLowerCase().includes(search),
    );
    return { ok: true, json: async (): Promise<unknown> => ({ servers }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Seed an owned agent, one linked source with the given pages, and declared surfaces.
 *
 * Args:
 *   harness: Convex test harness.
 *   pages: Page markdown keyed by ref.
 *   systems: Manager-named systems with their charter class.
 *
 * Returns:
 *   The agent id.
 */
async function seedOrientation(
  harness: TestConvex<typeof schema>,
  pages: Record<string, string>,
  systems: Array<{ name: string; class: string }>,
): Promise<{ agentId: Id<'agents'>; sourceId: Id<'docSources'> }> {
  const seeded = await harness.run(
    async (ctx): Promise<{ agentId: Id<'agents'>; sourceId: Id<'docSources'> }> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'orientation run test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      for (const [ref, markdown] of Object.entries(pages)) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown,
          updatedAt: 1,
        });
      }
      return { agentId, sourceId };
    },
  );
  await harness.mutation(internal.surfaces.seedFromCharter, {
    agentId: seeded.agentId,
    namedSystems: systems.map((system) => ({
      ...system,
      whereMentioned: `${system.name} was named in the 1:1.`,
    })),
  });
  return seeded;
}

/**
 * Read the surfaces of an agent keyed by slug.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: Agent under test.
 *
 * Returns:
 *   Surface rows by slug.
 */
async function surfacesBySlug(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
): Promise<Record<string, Doc<'surfaces'>>> {
  const rows = await harness.run(
    async (ctx) =>
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect(),
  );
  return Object.fromEntries(rows.map((row): [string, Doc<'surfaces'>] => [row.slug, row]));
}

/**
 * Execute the isolated orientation job for every declared surface in a test.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: Agent whose declared surfaces should be oriented.
 *
 * Returns:
 *   Counts of proposal and absence outcomes.
 */
async function orientDeclared(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
): Promise<{ proposed: number; absent: number }> {
  const surfaces = await surfacesBySlug(harness, agentId);
  const outcomes = await Promise.all(
    Object.values(surfaces).map(
      async (surface) =>
        await harness.action(internal.orientationActions.orientOne, {
          surfaceId: surface._id,
        }),
    ),
  );
  return {
    proposed: outcomes.filter((outcome) => outcome.outcome === 'proposed').length,
    absent: outcomes.filter((outcome) => outcome.outcome === 'absent').length,
  };
}

const LINEAR_RUNBOOK = [
  '# How to update a Linear ticket',
  '',
  'Use the `linear` surface for formal work in team `REVOPS`, project `Q3 close`. Where Linear is, how it is reached',
  'and the service token the automation uses are on the handbook page `Linear automation`, owned by',
  "the work management administrator. Never place the token's value in an action, skill, fixture,",
  'event or ledger row.',
  '',
  "The approved transport is Linear's Streamable HTTP MCP endpoint at",
  '`https://mcp.linear.app/mcp`. Treat the URL as connection metadata, not evidence of access: the',
  'surface remains ungranted until the manager and the administrator approve the connection and a',
  'probe succeeds.',
].join('\n');

const SLACK_RUNBOOK = [
  '# How to post to Slack',
  '',
  'Use the `slack` surface for `#revops-asks`, `#revops` and the manager DM. Where the workspace is,',
  'which channels exist, and how an automation obtains its own Slack app and bot token are on the',
  'handbook page `Slack automation policy`, owned by the messaging administrator.',
  '',
  'The approved transport is the Slack Web API over HTTPS at `https://slack.com/api/` with the bot',
  'token as a bearer. The surface remains ungranted until the manager and the administrator approve',
  'the connection and a probe (`auth.test`) succeeds.',
].join('\n');

const NORTHSTAR_PAGE = [
  '# Northstar CRM',
  '',
  'Northstar CRM is the synthetic internal system of record for account and opportunity ownership.',
  '',
  'The Business Systems owner controls access. No approved API, MCP server, browser route, credential',
  'or other integration surface is recorded in the team documentation.',
  '',
  'If work requires Northstar CRM, record the documentation locations and search terms used, then ask',
  'the manager to obtain an approved access path. Do not infer an endpoint from the system name, reuse',
  'credentials from another service or claim that no API exists.',
].join('\n');

const ONBOARDING_PAGE = [
  '# Revenue operations onboarding',
  '',
  '## Systems and access owners',
  '',
  '| System | What it is for | Access owner |',
  '|---|---|---|',
  '| Linear | Team `REVOPS`, project `Q3 close`, is the formal work queue and audit trail. | Work management administrator |',
  '| Slack | `#revops-asks` receives inbound requests, `#revops` is the team channel. | Messaging administrator |',
  '| Northstar CRM | Internal account and opportunity records used during close. No approved connection surface is recorded. | Business Systems owner |',
  '',
  '- For Northstar CRM work, ask the manager to obtain an approved access path. Do not substitute a',
  '  similarly named service or invent an endpoint.',
].join('\n');

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreSurfaceMode();
  resetFakeCredentials();
  model.pathFor = undefined;
});

describe('orientation evidence selection', (): void => {
  it('returns the exact documentation line naming a system', (): void => {
    expect(evidenceLine('# Systems\nUse Linear for the queue.\n', 'Linear')).toBe(
      'Use Linear for the queue.',
    );
    expect(evidenceLine('# Systems\nNo match.\n', 'Slack')).toBeUndefined();
  });

  it('does not apply another system denial to the named system', (): void => {
    const page = [
      '# Systems',
      '',
      '| Linear | Formal queue |',
      '| Northstar CRM | No approved connection surface is recorded. |',
    ].join('\n');
    expect(explicitlyDeniesSurface(page, 'Linear')).toBe(false);
    expect(explicitlyDeniesSurface(page, 'Northstar CRM')).toBe(true);
    const queue = [
      '## REVOPS-402',
      '',
      '- Source: Linear project `REVOPS`',
      '- Request: inspect Northstar CRM.',
      '- Acceptance: if no approved surface exists, ask the manager.',
    ].join('\n');
    expect(explicitlyDeniesSurface(queue, 'Linear')).toBe(false);
  });

  it('recognises denials phrased as no server or not approved', (): void => {
    expect(
      explicitlyDeniesSurface(
        '# Slack\n\nThere is no MCP server for Slack that we approve. Use the Web API at https://slack.com/api/',
        'Slack',
      ),
    ).toBe(true);
    expect(explicitlyDeniesSurface('# Access\n\nThe Jira MCP is not approved.', 'Jira')).toBe(true);
    expect(explicitlyDeniesSurface('Jira is not an approved surface for this team.', 'Jira')).toBe(
      true,
    );
    expect(
      explicitlyDeniesSurface('Jira changes not approved by the manager are held.', 'Jira'),
    ).toBe(true);
    expect(explicitlyDeniesSurface(LINEAR_RUNBOOK, 'Linear')).toBe(false);
    expect(explicitlyDeniesSurface(SLACK_RUNBOOK, 'Slack')).toBe(false);
    expect(explicitlyDeniesSurface(ONBOARDING_PAGE, 'Linear')).toBe(false);
    expect(explicitlyDeniesSurface(ONBOARDING_PAGE, 'Northstar CRM')).toBe(true);
  });

  it('uses the whole content of a dedicated runbook', (): void => {
    const page = '# How to update Linear\n\nUse MCP.\n\nEndpoint: https://mcp.linear.app/mcp';
    expect(relevantSystemText(page, 'Linear')).toContain('https://mcp.linear.app/mcp');
  });

  it('selects a matching Streamable HTTP registry remote only', (): void => {
    const payload = {
      servers: [
        {
          server: {
            name: 'app.linear/linear',
            title: 'Linear',
            remotes: [
              { type: 'sse', url: 'https://mcp.linear.app/sse' },
              { type: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
            ],
          },
        },
      ],
    };
    expect(registryRemoteEndpoint(payload, 'Linear')).toBe('https://mcp.linear.app/mcp');
    expect(registryRemoteEndpoint(payload, 'Unrelated CRM')).toBeUndefined();
  });
});

describe('credential extraction', (): void => {
  const pages = [
    'onboarding',
    'linear-automation',
    'slack-day0-app',
    'northstar-crm',
  ].map((name) => ({
    sourceId: 'source-fixture',
    ref: `${name}.md`,
    title: name,
    markdown: notionFixture(name),
  }));

  it('resolves a redacted Linear marker without exposing a value', (): void => {
    const finding = extractCredentialFinding(pages, 'Linear');
    expect(finding).toEqual({
      found: 'value',
      label: 'linear service token',
      evidenceRef: 'linear-automation.md',
      method: 'api-key',
      governanceFinding: 'credential found in a shared page - rotate into a vault',
      sourceId: 'source-fixture',
    });
    expect(JSON.stringify(finding)).not.toMatch(/Authorization: Bearer|ciphertext|plaintext/);
  });

  it('summarises Slack as an OAuth procedure with no value', (): void => {
    const finding = extractCredentialFinding(pages, 'Slack');
    expect(finding).toMatchObject({
      found: 'location',
      label: 'Slack OAuth access',
      evidenceRef: 'slack-day0-app.md',
      method: 'oauth',
      sourceId: 'source-fixture',
    });
    expect(finding.location).toContain('configuration token');
    expect(finding.location).toContain('OAuth redirect');
    expect(finding.governanceFinding).toBeUndefined();
  });

  it('does not borrow credentials for systems whose fixture names no access value', (): void => {
    expect(extractCredentialFinding(pages, 'Northstar CRM')).toEqual({
      found: 'none',
      method: 'unknown',
    });
  });
});

describe('URL attribution', (): void => {
  it('attributes a URL only when its sentence names the system or its host carries the slug', (): void => {
    const text =
      'Linear is reached over MCP at https://mcp.linear.app/mcp. Slack is the team chat. The wiki is at https://wiki.example.com/slack-rules.';
    expect(attributedUrls(text, 'Linear', 'linear')).toEqual(['https://mcp.linear.app/mcp']);
    expect(attributedUrls(text, 'Slack', 'slack')).toEqual([]);
    expect(attributedUrls('Endpoint: `https://mcp.linear.app/mcp`.', 'Linear', 'linear')).toEqual([
      'https://mcp.linear.app/mcp',
    ]);
    expect(
      attributedUrls(
        'Log in at https://crm.northstar.example/login',
        'Northstar CRM',
        'northstar-crm',
      ),
    ).toEqual([]);
    expect(
      attributedUrls(
        'Northstar CRM web UI: https://crm.northstar.example/login.',
        'Northstar CRM',
        'northstar-crm',
      ),
    ).toEqual(['https://crm.northstar.example/login']);
  });

  it('never takes a URL from a sentence that denies the surface', (): void => {
    expect(
      attributedUrls(
        'The Slack MCP at https://old.slack-gateway.example/mcp is not approved. Use the Web API at https://slack.com/api/',
        'Slack',
        'slack',
      ),
    ).toEqual(['https://slack.com/api/']);
  });

  it('groups endpoints by kind and admits paths from evidence alone', (): void => {
    expect(
      documentedEndpoints([
        'https://app.example.com/login',
        'https://api.example.com/v1',
        'https://mcp.example.com/mcp',
      ]),
    ).toEqual({
      mcp: 'https://mcp.example.com/mcp',
      api: 'https://api.example.com/v1',
      webUi: 'https://app.example.com/login',
    });
    expect(choosePath('documented-api', { mcp: 'https://mcp.example.com/mcp' })).toEqual({
      path: 'mcp',
      endpoint: 'https://mcp.example.com/mcp',
    });
    expect(choosePath('mcp', { api: 'https://slack.com/api/' })).toEqual({
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
    });
    expect(choosePath('browser-driven', { webUi: 'https://app.example.com' })).toEqual({
      path: 'browser-driven',
      endpoint: 'https://app.example.com',
    });
    expect(choosePath('mcp', { webUi: 'https://app.example.com' })).toEqual({ path: 'escalate' });
    expect(choosePath('mcp', {})).toEqual({ path: 'escalate' });
  });
});

describe('orientation run', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
    useSurfaceMode('real');
  });

  it("does not lend one system's MCP endpoint to another named in the same paragraph", async (): Promise<void> => {
    const fetchMock = stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId } = await seedOrientation(
      harness,
      {
        'systems.md':
          '# Systems\n\nLinear is reached over MCP at https://mcp.linear.app/mcp. Slack is the team chat.',
      },
      [
        { name: 'Linear', class: 'kanban' },
        { name: 'Slack', class: 'chat' },
      ],
    );
    await expect(orientDeclared(harness, agentId)).resolves.toEqual({
      proposed: 2,
      absent: 0,
    });
    const surfaces = await surfacesBySlug(harness, agentId);
    expect(surfaces.linear).toMatchObject({
      verdict: 'proposed',
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
    });
    expect(surfaces.slack).toMatchObject({ verdict: 'proposed', path: 'escalate' });
    expect(surfaces.slack.endpoint).toBeUndefined();
    const request = surfaces.slack.request as {
      registrySuggestion?: { endpoint: string };
      openQuestions: string[];
    };
    expect(request.registrySuggestion?.endpoint).toBe(
      'https://server.smithery.ai/@smithery-ai/slack/mcp',
    );
    expect(request.openQuestions.join(' ')).toContain('not linked evidence');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('search=Slack');
  });

  it('prefers a documented API over a denied MCP path, whatever the model says', async (): Promise<void> => {
    const fetchMock = stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId } = await seedOrientation(
      harness,
      {
        'slack.md':
          '# Slack\n\nThere is no MCP server for Slack that we approve. Use the Web API at https://slack.com/api/',
      },
      [{ name: 'Slack', class: 'chat' }],
    );
    await expect(orientDeclared(harness, agentId)).resolves.toEqual({
      proposed: 1,
      absent: 0,
    });
    const surfaces = await surfacesBySlug(harness, agentId);
    expect(surfaces.slack).toMatchObject({
      verdict: 'proposed',
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never writes a registry hit as the endpoint of a system the docs only mention', async (): Promise<void> => {
    const fetchMock = stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId } = await seedOrientation(
      harness,
      {
        'crm.md':
          '# Northstar CRM\n\nNorthstar CRM has an MCP server; ask the Business Systems owner.',
      },
      [{ name: 'Northstar CRM', class: 'crm' }],
    );
    await expect(orientDeclared(harness, agentId)).resolves.toEqual({
      proposed: 1,
      absent: 0,
    });
    const surface = (await surfacesBySlug(harness, agentId))['northstar-crm'];
    expect(surface).toMatchObject({ verdict: 'proposed', path: 'escalate' });
    expect(surface.endpoint).toBeUndefined();
    expect(
      (surface.request as { registrySuggestion?: { endpoint: string } }).registrySuggestion,
    ).toEqual({
      endpoint: 'https://community.example/northstar/mcp',
      note: expect.stringContaining('not linked evidence'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('files the three cards from the folder documentation even when the model is unavailable', async (): Promise<void> => {
    const fetchMock = stubRegistry();
    model.pathFor = undefined;
    const harness = convexTest(schema, orientationModules());
    const { agentId } = await seedOrientation(
      harness,
      {
        'onboarding.md': ONBOARDING_PAGE,
        'runbooks/how-to-update-ticket.md': LINEAR_RUNBOOK,
        'runbooks/how-to-post-slack.md': SLACK_RUNBOOK,
        'systems/northstar-crm.md': NORTHSTAR_PAGE,
      },
      [
        { name: 'Linear', class: 'kanban' },
        { name: 'Slack', class: 'chat' },
        { name: 'Northstar CRM', class: 'crm' },
      ],
    );
    await expect(orientDeclared(harness, agentId)).resolves.toEqual({
      proposed: 2,
      absent: 1,
    });
    const surfaces = await surfacesBySlug(harness, agentId);
    expect(surfaces.linear).toMatchObject({
      verdict: 'proposed',
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
    });
    expect(surfaces.slack).toMatchObject({
      verdict: 'proposed',
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
    });
    expect(surfaces['northstar-crm']).toMatchObject({
      verdict: 'absent',
      reason: 'No approved surface found after searching: Northstar CRM, crm',
    });
    expect(surfaces['northstar-crm'].endpoint).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds credential findings from all four sanitised Notion fixtures', async (): Promise<void> => {
    stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId, sourceId } = await seedOrientation(
      harness,
      {
        'onboarding.md': notionFixture('onboarding'),
        'linear-automation.md': notionFixture('linear-automation'),
        'slack-day0-app.md': notionFixture('slack-day0-app'),
        'northstar-crm.md': notionFixture('northstar-crm'),
      },
      [
        { name: 'Linear', class: 'kanban' },
        { name: 'Slack', class: 'chat' },
        { name: 'Northstar CRM', class: 'crm' },
      ],
    );
    const stored = seedFakeCredential({
      userId: 'owner',
      sourceId: String(sourceId),
      ref: 'linear-automation.md',
      label: 'linear service token',
      plaintext: 'local-value-orientation-never-reads',
    });
    await expect(orientDeclared(harness, agentId)).resolves.toEqual({
      proposed: 2,
      absent: 1,
    });
    const surfaces = await surfacesBySlug(harness, agentId);
    expect(surfaces.linear.request).toMatchObject({
      credential: {
        found: 'value',
        label: 'linear service token',
        evidenceRef: 'linear-automation.md',
        method: 'api-key',
        governanceFinding: 'credential found in a shared page - rotate into a vault',
      },
    });
    expect(surfaces.linear.request).not.toHaveProperty('credential.sourceId');
    expect(surfaces.linear.credentialId).toBe(stored._id);
    expect(fakeCredentialState().storeCalls).toEqual([]);
    expect(JSON.stringify(surfaces)).not.toContain('local-value-orientation-never-reads');
    expect(surfaces.linear.request).not.toHaveProperty('credential.plaintext');
    expect(surfaces.slack).toMatchObject({
      path: 'documented-api',
      credentialLocation: expect.stringContaining('configuration token'),
      request: {
        credential: {
          found: 'location',
          evidenceRef: 'slack-day0-app.md',
          method: 'oauth',
        },
      },
    });
    expect(surfaces['northstar-crm'].verdict).toBe('absent');
  });

  it('resolves a marker on a multi-value page through its label-qualified ref', async (): Promise<void> => {
    stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId, sourceId } = await seedOrientation(
      harness,
      { 'linear-automation.md': notionFixture('linear-automation') },
      [{ name: 'Linear', class: 'kanban' }],
    );
    seedFakeCredential({
      userId: 'owner',
      sourceId: String(sourceId),
      ref: 'linear-automation.md#credential=1-some%20other%20secret',
      label: 'some other secret',
      plaintext: 'other',
    });
    const wanted = seedFakeCredential({
      userId: 'owner',
      sourceId: String(sourceId),
      ref: 'linear-automation.md#credential=2-linear%20service%20token',
      label: 'linear service token',
      plaintext: 'linear',
    });
    await orientDeclared(harness, agentId);
    expect((await surfacesBySlug(harness, agentId)).linear.credentialId).toBe(wanted._id);
  });

  it('leaves the credential unresolved, and says so, when no stored row matches the marker', async (): Promise<void> => {
    stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId, sourceId } = await seedOrientation(
      harness,
      { 'linear-automation.md': notionFixture('linear-automation') },
      [{ name: 'Linear', class: 'kanban' }],
    );
    seedFakeCredential({
      userId: 'owner',
      sourceId: String(sourceId),
      ref: 'linear-automation.md',
      label: 'linear service token',
      plaintext: 'revoked',
      revokedAt: 5,
    });
    await orientDeclared(harness, agentId);
    const linear = (await surfacesBySlug(harness, agentId)).linear;
    expect(linear.verdict).toBe('proposed');
    expect(linear.credentialId).toBeUndefined();
    expect((linear.request as { openQuestions: string[] }).openQuestions.join(' ')).toContain(
      'could not be resolved',
    );
    expect(fakeCredentialState().storeCalls).toEqual([]);
  });

  it('fans out one scheduled job per declared system and isolates a stale job', async (): Promise<void> => {
    stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId } = await seedOrientation(
      harness,
      { 'linear.md': LINEAR_RUNBOOK, 'slack.md': SLACK_RUNBOOK },
      [
        { name: 'Linear', class: 'kanban' },
        { name: 'Slack', class: 'chat' },
      ],
    );
    await expect(harness.action(internal.orientationActions.run, { agentId })).resolves.toEqual({
      scheduled: 2,
    });
    const scheduled = await surfacesBySlug(harness, agentId);
    expect(scheduled.linear.verdict).toBe('declared');
    expect(scheduled.slack.verdict).toBe('declared');
    await harness.mutation(internal.surfaces.markAbsent, {
      surfaceId: scheduled.slack._id,
      searched: ['Slack'],
      whereFound: [],
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const completed = await surfacesBySlug(harness, agentId);
    expect(completed.linear.verdict).toBe('proposed');
    expect(completed.slack.verdict).toBe('absent');
    expect((await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
      (event): boolean => event.type === 'surface.proposed',
    )).toHaveLength(1);
  });

  it('lets the owner re-run orientation for declared surfaces in real mode', async (): Promise<void> => {
    stubRegistry();
    model.pathFor = (): DraftPath => 'mcp';
    const harness = convexTest(schema, orientationModules());
    const { agentId } = await seedOrientation(harness, { 'linear.md': LINEAR_RUNBOOK }, [
      { name: 'Linear', class: 'kanban' },
    ]);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.action(api.surfaces.reorient, { agentId })).resolves.toEqual({ scheduled: 1 });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const surfaceId = (await surfacesBySlug(harness, agentId)).linear._id;
    await owner.mutation(api.surfaces.reject, { surfaceId, reason: 'Wrong endpoint.' });
    await expect(owner.action(api.surfaces.reorient, { agentId })).resolves.toEqual({ scheduled: 1 });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await surfacesBySlug(harness, agentId)).linear).toMatchObject({
      verdict: 'proposed',
      endpoint: 'https://mcp.linear.app/mcp',
    });
    await expect(
      harness.withIdentity({ subject: 'other-owner' }).action(api.surfaces.reorient, { agentId }),
    ).rejects.toThrow('forbidden');
  });
});
