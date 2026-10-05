import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { BROWSER_DRIVER_ABSENT } from '../../src/surfaces/browser';
import { allConvexModules } from './all-modules';
import { companyPage } from '../fixtures/company-bed';
import type { ListedSurface } from '../../convex/surfaces';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/**
 * What `surfaces.listForAgent` hands the Surfaces tab's cards beyond the stored row: the reason
 * a proposed card cannot be approved now (E-63), so the card disables Approve with the reason
 * rather than meeting it as a thrown refusal on the click.
 */

afterEach((): void => {
  restoreSurfaceMode();
});

const QUEUE_CHANGED =
  'A documented intake queue changed; reject this card and re-run orientation before approval.';

/** An owned agent, a linked source with one handbook page, and the harness they live in. */
async function seedOffice(handbook: string): Promise<{
  harness: TestConvex<typeof schema>;
  agentId: Id<'agents'>;
  sourceId: Id<'docSources'>;
}> {
  const harness = convexTest(schema, allConvexModules());
  const ids = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Mira',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Runbooks',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'handbook.md',
      title: 'Handbook',
      markdown: handbook,
      updatedAt: 1,
    });
    return { agentId, sourceId };
  });
  return { harness, ...ids };
}

/** Insert one surface card for the agent with the fields a test needs. */
async function card(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'surfaces'>> & Pick<Doc<'surfaces'>, 'slug'>,
): Promise<Id<'surfaces'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('surfaces', {
        agentId,
        displayName: fields.slug,
        class: 'kanban',
        verdict: 'proposed',
        path: 'mcp',
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
        ...fields,
      }),
  );
}

describe('the approval refusal on a listed card (E-63)', (): void => {
  it('names why a proposed card whose documented queue changed cannot be approved', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice('- Team: `FINANCE`');
    await card(harness, agentId, {
      slug: 'linear',
      intakeScope: {
        team: { value: 'REVOPS', sourceId, ref: 'handbook.md', quote: '- Team: `REVOPS`' },
      },
    });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed).toMatchObject([{ slug: 'linear', approvalRefusal: QUEUE_CHANGED }]);
  });

  it('names the absent browser component on a proposed browser-driven card', async (): Promise<void> => {
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const { harness, agentId } = await seedOffice('- Team: `REVOPS`');
    await card(harness, agentId, { slug: 'looker', class: 'analytics', path: 'browser-driven' });

    const [looker] = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(looker?.approvalRefusal).toContain(BROWSER_DRIVER_ABSENT);
  });

  it('leaves the refusal off a card that can be approved, and off every card past proposal', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice('- Team: `REVOPS`');
    const scope = {
      team: { value: 'REVOPS', sourceId, ref: 'handbook.md', quote: '- Team: `REVOPS`' },
    };
    await card(harness, agentId, { slug: 'linear', intakeScope: scope });
    await card(harness, agentId, {
      slug: 'jira',
      verdict: 'connected',
      intakeScope: { team: { ...scope.team, quote: '- Team: `GONE`' } },
    });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed.map((row) => [row.slug, row.approvalRefusal])).toEqual([
      ['linear', undefined],
      ['jira', undefined],
    ]);
  });
});

/** An onboarding page whose systems table names Slack before Linear. */
const ONBOARDING = [
  '# RevOps onboarding',
  '',
  '## Systems and access owners',
  '',
  '| System | Owner |',
  '| --- | --- |',
  '| Slack | Sara |',
  '| Linear | Aman |',
].join('\n');

/** A page of the office's documentation, stored under the office's one source. */
async function page(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
  ref: string,
  markdown: string,
): Promise<void> {
  await harness.run(async (ctx) => {
    await ctx.db.insert('docPages', { sourceId, ref, title: ref, markdown, updatedAt: 1 });
  });
}

/** The documentation evidence discovery records for a system found on one page. */
function discoveredOn(sourceId: Id<'docSources'>, ref: string, quote: string) {
  return [
    {
      kind: 'documentation' as const,
      sourceId,
      ref,
      quote,
      current: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    },
  ];
}

describe('the order of the listed cards (D D4)', (): void => {
  it('lists the cards in the order the documented systems table gives, read on the server', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice('- Team: `REVOPS`');
    await page(harness, sourceId, 'onboarding.md', ONBOARDING);
    await card(harness, agentId, {
      slug: 'linear',
      displayName: 'Linear',
      discoveryEvidence: discoveredOn(sourceId, 'onboarding.md', '| Linear | Aman |'),
    });
    await card(harness, agentId, {
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      discoveryEvidence: discoveredOn(sourceId, 'onboarding.md', '| Slack | Sara |'),
    });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed.map((row) => row.slug)).toEqual(['slack', 'linear']);
  });

  it('orders by class when no page the cards cite carries a systems table', async (): Promise<void> => {
    const { harness, agentId } = await seedOffice('- Team: `REVOPS`');
    // Inserted chat first, so the order below is the class rule's, not the insertion's.
    await card(harness, agentId, { slug: 'slack', displayName: 'Slack', class: 'chat' });
    await card(harness, agentId, { slug: 'linear', displayName: 'Linear', class: 'kanban' });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed.map((row) => row.slug)).toEqual(['linear', 'slack']);
  });

  it('reads no page of a source the employee was deployed without', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice('- Team: `REVOPS`');
    await page(harness, sourceId, 'onboarding.md', ONBOARDING);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { excludedDocSourceIds: [sourceId] });
    });
    await card(harness, agentId, {
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      discoveryEvidence: discoveredOn(sourceId, 'onboarding.md', '| Slack | Sara |'),
    });
    await card(harness, agentId, { slug: 'linear', displayName: 'Linear', class: 'kanban' });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed.map((row) => row.slug)).toEqual(['linear', 'slack']);
  });
});

describe('the drift of an approved scope, as a server field (D D4)', (): void => {
  const FINANCE = companyPage('finance/handbook.md').markdown;

  /** A connected Linear card whose approved scope quotes the finance handbook. */
  async function financeCard(
    markdown: string,
    verdict: Doc<'surfaces'>['verdict'] = 'connected',
  ): Promise<ListedSurface | undefined> {
    const { harness, agentId, sourceId } = await seedOffice('- Team: `REVOPS`');
    await page(harness, sourceId, 'finance/handbook.md', markdown);
    const quoted = (value: string, quote: string) => ({
      value,
      sourceId,
      ref: 'finance/handbook.md',
      quote,
    });
    await card(harness, agentId, {
      slug: 'linear',
      verdict,
      intakeScope: {
        team: quoted('FIN', '- Team: `FIN`'),
        project: quoted('September close', '- Project: `September close`'),
      },
    });
    const [linear] = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });
    return linear;
  }

  it('says which approved value its page no longer states, and what to do', async (): Promise<void> => {
    // The handbook states the project twice (lines 10 and 32); the card judges
    // by value, so the page has stopped stating it only once both go.
    const drifted = FINANCE.replaceAll('`September close`', '`October close`');

    expect((await financeCard(drifted, 'proposed'))?.scopeChange).toBe(
      'Changed since this card was proposed: project September close is no longer stated on finance/handbook.md. Intake still reads only what was approved; reject the card and re-run orientation to propose the page as it reads now.',
    );
    // Only a proposed card offers Reject, so a connected one is not told to reject it.
    expect((await financeCard(drifted, 'connected'))?.scopeChange).toBe(
      'Changed since this card was proposed: project September close is no longer stated on finance/handbook.md. Intake still reads only what was approved.',
    );
  });

  it('keeps a value the page still states on another line: a reworded line is not drift (U8 D2)', async (): Promise<void> => {
    const linear = await financeCard(
      FINANCE.replace('- Project: `September close`', '- Project: `October close`'),
    );

    expect(linear?.scopeChange).toBeUndefined();
  });
});

describe('the intake-queue guard, judged by value (M3, D D9)', (): void => {
  const STORED = { value: 'REVOPS', ref: 'handbook.md', quote: '- Team: `REVOPS`' };
  const RESTATED = '- Team:  `REVOPS`  (the request queue; ask Aman first)';

  afterEach((): void => {
    vi.useRealTimers();
  });

  /** What a call threw, or undefined when it answered. */
  async function thrown(call: Promise<unknown>): Promise<unknown> {
    return await call.then(
      (): unknown => undefined,
      (error: unknown): unknown => error,
    );
  }

  it('leaves Approve enabled when the queue line is only re-spaced or given a trailing remark', async (): Promise<void> => {
    const { harness, agentId, sourceId } = await seedOffice(RESTATED);
    await card(harness, agentId, {
      slug: 'linear',
      intakeScope: { team: { ...STORED, sourceId } },
    });

    const [linear] = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(linear?.approvalRefusal).toBeUndefined();
    expect(linear?.scopeChange).toBeUndefined();
  });

  it('approves that card and stores the line as it reads now, so intake reads what was approved', async (): Promise<void> => {
    useSurfaceMode('real');
    // The approval schedules the card's probe; held on the fake clock, it never runs here.
    vi.useFakeTimers();
    const { harness, agentId, sourceId } = await seedOffice(RESTATED);
    const surfaceId = await card(harness, agentId, {
      slug: 'linear',
      intakeScope: { team: { ...STORED, sourceId } },
    });

    await harness.withIdentity(managerIdentity()).mutation(api.surfaces.approve, { surfaceId });

    const row = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(row?.verdict).toBe('approved');
    expect(row?.intakeScope?.team).toEqual({ ...STORED, sourceId, quote: RESTATED.trim() });
  });

  it('refuses the approval, as a ConvexError the card can read, once the page stops stating the value', async (): Promise<void> => {
    useSurfaceMode('real');
    const { harness, agentId, sourceId } = await seedOffice('- Team: `FINANCE`');
    const surfaceId = await card(harness, agentId, {
      slug: 'linear',
      intakeScope: { team: { ...STORED, sourceId } },
    });

    const refusal = await thrown(
      harness.withIdentity(managerIdentity()).mutation(api.surfaces.approve, { surfaceId }),
    );

    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<string>).data).toBe(QUEUE_CHANGED);
  });

  it('refuses a reject of a card past approval, and of a gone one, with a ConvexError the card can read', async (): Promise<void> => {
    useSurfaceMode('real');
    const { harness, agentId } = await seedOffice('- Team: `REVOPS`');
    const surfaceId = await card(harness, agentId, { slug: 'linear', verdict: 'declared' });
    const owner = harness.withIdentity(managerIdentity());

    const refusal = await thrown(owner.mutation(api.surfaces.reject, { surfaceId, reason: 'no' }));
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<string>).data).toBe(
      'Only a proposed or approved surface can be rejected; this one is declared.',
    );

    await harness.run(async (ctx) => await ctx.db.delete(surfaceId));
    const gone = await thrown(owner.mutation(api.surfaces.reject, { surfaceId, reason: 'no' }));
    expect(gone).toBeInstanceOf(ConvexError);
    expect((gone as ConvexError<string>).data).toBe('Surface not found.');
  });
});

describe("a pending authorisation on a listed card (11-AC's cockpit item 7)", (): void => {
  it('lists when it started and when its link lapses, never the sealed verifier or the nonce', async (): Promise<void> => {
    const { harness, agentId } = await seedOffice('# Handbook');
    await card(harness, agentId, {
      slug: 'docs',
      verdict: 'approved',
      endpoint: 'https://docs.acme.test/mcp',
      managerApprovedAt: 1,
      pendingAuthorisation: {
        stateNonce: 'nonce-1',
        stateExpiresAt: 50_000,
        clientId: 'day0-mcp',
        verifierCiphertext: 'sealed-verifier',
        verifierIv: 'iv',
        issuer: 'https://auth.acme.test',
        resource: 'https://docs.acme.test/mcp',
        redirectUrl: 'https://day0.acme.test/api/oauth/mcp',
        startedAt: 1_000,
      },
    });

    const [listed] = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(listed?.pendingAuthorisation).toEqual({ startedAt: 1_000, stateExpiresAt: 50_000 });
    expect(JSON.stringify(listed)).not.toContain('sealed-verifier');
    expect(JSON.stringify(listed)).not.toContain('nonce-1');
  });
});

describe('a card an administrator ended by revoking its connection (the pre-tag second pass)', (): void => {
  it('says so on the listed card once it holds no credential, and nothing on a card on a live connection', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, revokedCard, liveCard } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const connection = (status: 'active' | 'revoked', system: string) =>
        ctx.db.insert('organisationConnections', {
          system,
          displayName: system,
          kind: 'oauth-app',
          mode: 'shared',
          scopes: [],
          registeredBy: { via: 'setup-cli', at: 1 },
          status,
          createdAt: 1,
          ...(status === 'revoked' ? { revokedAt: 2, statusReason: 'moving' } : {}),
        });
      const card = (
        slug: string,
        endpoint: string,
        organisationConnectionId: Id<'organisationConnections'>,
      ) =>
        ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: slug,
          class: 'kanban',
          path: 'documented-api',
          endpoint,
          verdict: 'approved',
          whereFound: [],
          managerApprovedAt: 1,
          credentialLanded: false,
          organisationConnectionId,
          reason: 'moving',
          createdAt: 1,
        });
      return {
        agentId,
        revokedCard: await card(
          'linear',
          'https://api.linear.app/graphql',
          await connection('revoked', 'linear'),
        ),
        liveCard: await card(
          'github',
          'https://api.github.com',
          await connection('active', 'github'),
        ),
      };
    });

    const cards = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(cards.find((card) => card._id === revokedCard)?.connectionRevoked).toBe(true);
    expect(cards.find((card) => card._id === liveCard)?.connectionRevoked).toBeUndefined();

    // Once IT lands Linear again the card is no longer one a revoke ended (the code pass's m2).
    await harness.run(async (ctx) => {
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: [],
        registeredBy: { via: 'setup-cli', at: 3 },
        status: 'active',
        createdAt: 3,
      });
    });
    const after = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });
    expect(after.find((card) => card._id === revokedCard)?.connectionRevoked).toBeUndefined();
  });

  it("says a Slack card's own app is not installed again once its creating connection is revoked, before and after IT connects Slack again (W12X-4)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const slackConnection = (status: 'active' | 'revoked', at: number) =>
      harness.run(
        async (ctx) =>
          await ctx.db.insert('organisationConnections', {
            system: 'slack',
            displayName: 'Slack',
            kind: 'slack-configuration',
            mode: 'per-employee',
            scopes: [],
            registeredBy: { via: 'setup-cli', at },
            status,
            createdAt: at,
            ...(status === 'revoked' ? { revokedAt: at + 1, statusReason: 'ending' } : {}),
          }),
      );
    const revokedCreator = await slackConnection('revoked', 1);
    const liveCreator = await slackConnection('active', 2);
    const { agentId, endedCard, liveCard, heldCard } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Dara',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const credential = () =>
        ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'oauth',
          label: 'Slack',
          source: 'oauth',
          createdAt: 1,
        });
      const clientSecretCredentialId = await credential();
      const card = (
        slug: string,
        organisationConnectionId: Id<'organisationConnections'>,
        credentialId?: Id<'credentials'>,
      ) =>
        ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: 'Slack',
          class: 'chat',
          path: 'documented-api',
          endpoint: 'https://slack.com/api/',
          verdict: 'approved',
          whereFound: [],
          managerApprovedAt: 1,
          credentialLanded: credentialId !== undefined,
          organisationConnectionId,
          ...(credentialId === undefined ? {} : { credentialId }),
          provisioning: {
            appId: `A-${slug}`,
            appName: 'Dara (Day0)',
            clientId: '1.2',
            clientSecretCredentialId,
            installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1.2',
            redirectUrl: 'https://day0.test/api/oauth/slack',
            scopes: ['chat:write'],
            organisationConnectionId,
            createdAt: 1,
            installedAt: 2,
          },
          createdAt: 1,
        });
      const credentialId = await credential();
      return {
        agentId,
        endedCard: await card('slack', revokedCreator),
        liveCard: await card('slack-live', liveCreator),
        heldCard: await card('slack-held', revokedCreator, credentialId),
      };
    });

    const cards = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });
    expect(cards.find((card) => card._id === endedCard)?.keptAppNotReinstalled).toBe(true);
    expect(cards.find((card) => card._id === liveCard)?.keptAppNotReinstalled).toBeUndefined();
    expect(cards.find((card) => card._id === heldCard)?.keptAppNotReinstalled).toBeUndefined();
    // Another Slack connection active since is no creator of this app: it stays not installed.
    expect(cards.find((card) => card._id === endedCard)?.connectionRevoked).toBeUndefined();
  });
});
