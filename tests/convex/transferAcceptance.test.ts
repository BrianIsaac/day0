import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schema from '../../convex/schema';
import { SOURCE_NOT_YOURS } from '../../convex/transferAcceptance';
import { EMPLOYEE_LEFT_ASKER } from '../../convex/transferPreview';
import { HANDOVER_CUT_REASON } from '../../convex/surfaces';
import { OUTCOME_UNKNOWN_REASON } from '../../src/work/reconciliation';
import { EMPLOYEE_NOT_YOURS } from '../../src/agent/employee-access';
import {
  TRANSFER_NOT_FOUND,
  OWN_TRANSFER,
  transferExpiresAt,
  transferStateRefusal,
} from '../../src/agent/manager-transfer';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/** The account the handover names, signed in with its verified address. */
const COLLEAGUE = managerIdentity('colleague');

/** The named account's address. */
const COLLEAGUE_ADDRESS = fixtureAddressOf('colleague');

/** The asking manager. */
const OWNER = managerIdentity();

/** The old owner's strings that must never reach the new owner (transfer plan 14.1, item 2). */
const OWNER_SECRETS = [
  'Linear service token',
  'Slack bot token',
  'Owner handbook',
  'OWNER-QUOTE-LINEAR',
  'OWNER-PAGE-BODY',
  'Owner runbook page',
  'OWNER-ONE-TO-ONE-ANSWER',
  'OWNER-ONE-TO-ONE-TURN',
] as const;

/** The reporting-line rule the old manager's charter carries. */
const REPORTING_LINE = 'Report every escalation to Sam before the Friday close.';

type Harness = TestConvex<typeof schema>;

/** One owner's office with an employee asked to be handed to a colleague. */
interface Office {
  readonly harness: Harness;
  readonly maya: Id<'agents'>;
  readonly tomas: Id<'agents'>;
  readonly priya: Id<'agents'>;
  readonly transferId: Id<'managerTransfers'>;
  /** Maya's approved charter, drafted from the old manager's finished one-to-one. */
  readonly charterId: Id<'charters'>;
  readonly ownerSource: Id<'docSources'>;
  readonly colleagueSource: Id<'docSources'>;
  readonly only: Id<'credentials'>;
  readonly shared: Id<'credentials'>;
  readonly linear: Id<'surfaces'>;
  readonly slack: Id<'surfaces'>;
  readonly tomasSlack: Id<'surfaces'>;
}

/** A harness whose modules resolved the surface mode the enclosing block's `beforeEach` set. */
async function modeHarness(): Promise<Harness> {
  const [{ default: modeSchema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(modeSchema, allConvexModules());
}

/** The fields every work item in these tests shares. */
function workItemFields(
  agentId: Id<'agents'>,
  externalId: string,
): Omit<Doc<'workItems'>, '_id' | '_creationTime' | 'state'> {
  return {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    externalClaimKey: `linear:${externalId}`,
    title: `Close ${externalId}`,
    contentSummary: `Close ${externalId}`,
    contentRefs: [],
    observedAt: 1,
    createdAt: 1,
  };
}

/**
 * Seed the owner's office: Maya, asked to be handed to the colleague, with an approved charter
 * carrying a reporting-line rule, a Linear surface on a credential only she binds and a Slack
 * surface on one Tomas binds too, both with the owner's documentation quoted on them, a page
 * mirrored from the owner's handbook beside a seeded office page, her grants, her record and an
 * open plan. The colleague owns a handbook of their own and an employee, Priya. The surface
 * mode is the one the enclosing block's `beforeEach` set.
 */
async function seedOffice(): Promise<Office> {
  const harness = await modeHarness();
  const seeded = await harness.run(async (ctx) => {
    const source = async (userId: string, label: string): Promise<Id<'docSources'>> =>
      await ctx.db.insert('docSources', {
        userId,
        label,
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
    const ownerSource = await source('owner', 'Owner handbook');
    const colleagueSource = await source('colleague', 'Colleague handbook');
    const credential = async (label: string): Promise<Id<'credentials'>> =>
      await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label,
        ciphertext: 'sealed',
        iv: 'iv',
        source: { sourceId: ownerSource, ref: 'linear.md' },
        createdAt: 1,
      });
    const only = await credential('Linear service token');
    const shared = await credential('Slack bot token');
    const employee = async (
      userId: string,
      name: string,
      fields: Partial<Doc<'agents'>> = {},
    ): Promise<Id<'agents'>> =>
      await ctx.db.insert('agents', {
        bossEmail: userId === 'owner' ? MANAGER_ADDRESS : COLLEAGUE_ADDRESS,
        name,
        userId,
        state: 'active',
        createdAt: 1,
        ...fields,
      });
    const maya = await employee('owner', 'Maya', {
      autonomousActions: true,
      managerNotifications: 'digest',
      zone: 'Europe/London',
    });
    const tomas = await employee('owner', 'Tomas');
    const priya = await employee('colleague', 'Priya');
    const body = runThroughBody();
    const charterId = await ctx.db.insert('charters', {
      agentId: maya,
      version: '0.1',
      body: {
        ...body,
        constraints: [
          ...(body.constraints ?? []),
          { kind: 'reporting-line', quote: REPORTING_LINE, wording: [], origin: 'synthesis' },
        ],
      },
      approved: true,
      approvedAt: 2,
      createdAt: 2,
    });
    await ctx.db.insert('voiceSessions', {
      agentId: maya,
      mode: 'chat',
      state: 'done',
      answers: { 'why-this-hire': 'OWNER-ONE-TO-ONE-ANSWER' },
      transcriptText: 'Employee: Why was I hired?\nManager: OWNER-ONE-TO-ONE-TURN',
      turns: [
        { id: 't1', speaker: 'employee', text: 'Why was I hired?', at: 1 },
        { id: 't2', speaker: 'manager', text: 'OWNER-ONE-TO-ONE-TURN', topicIndex: 0, at: 2 },
      ],
      charterId,
      charterVersion: '0.1',
      startedAt: 1,
      endedAt: 2,
    });
    await ctx.db.insert('workspace', {
      agentId: maya,
      fileName: 'IDENTITY.md',
      content: `# IDENTITY\n\n## Manager (who approves)\n- ${MANAGER_ADDRESS}\n`,
      updatedAt: 2,
    });
    await ctx.db.insert('workspace', {
      agentId: maya,
      fileName: 'USER.md',
      content: `# USER\n\nBoss: ${MANAGER_ADDRESS}\n`,
      updatedAt: 2,
    });
    const documentation = {
      kind: 'documentation' as const,
      sourceId: ownerSource,
      ref: 'linear.md',
      quote: 'OWNER-QUOTE-LINEAR: triage in Linear with the service token.',
      current: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    const connected = {
      class: 'kanban',
      path: 'mcp',
      verdict: 'connected' as const,
      managerApprovedAt: 2,
      credentialKind: 'value' as const,
      credentialLanded: true,
      createdAt: 1,
    };
    const linear = await ctx.db.insert('surfaces', {
      ...connected,
      agentId: maya,
      slug: 'linear',
      displayName: 'Linear',
      credentialId: only,
      discoveryEvidence: [documentation],
      whereFound: [
        { sourceId: String(ownerSource), ref: 'linear.md', quote: 'OWNER-QUOTE-LINEAR' },
      ],
      request: {
        target: { system: 'Linear', chosenPath: 'mcp' },
        evidence: [
          { sourceId: String(ownerSource), ref: 'linear.md', quote: 'OWNER-QUOTE-LINEAR' },
        ],
        credential: { method: 'api-key', found: 'value', label: 'Linear service token' },
      },
    });
    const slack = await ctx.db.insert('surfaces', {
      ...connected,
      agentId: maya,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      credentialId: shared,
      managerUserId: 'U-OWNER',
      managerDmChannelId: 'D-OWNER',
      whereFound: [],
    });
    const tomasSlack = await ctx.db.insert('surfaces', {
      ...connected,
      agentId: tomas,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      credentialId: shared,
      whereFound: [],
    });
    const page = async (slug: string, title: string, sourceId?: Id<'docSources'>) =>
      await ctx.db.insert('mockDocs', {
        agentId: maya,
        slug,
        title,
        body: sourceId ? 'OWNER-PAGE-BODY' : '# Welcome to the office',
        category: 'team-doc',
        ...(sourceId ? { sourceId, sourceRef: 'runbook.md' } : {}),
        updatedAt: 1,
      });
    await page('office-welcome', 'Welcome');
    await page('owner-runbook', 'Owner runbook page', ownerSource);
    await ctx.db.insert('mockTickets', {
      agentId: maya,
      slug: 'ticket-1',
      title: 'An office ticket',
      status: 'open',
      body: 'The hosted office is the employee’s world.',
      comments: [],
      updatedAt: 1,
    });
    const grant = async (scope: string, source: Doc<'permissionGrants'>['source']) =>
      await ctx.db.insert('permissionGrants', { agentId: maya, scope, source, createdAt: 1 });
    await grant('linear:read', 'surface');
    await grant('linear:write', 'manager');
    await ctx.db.insert('events', {
      agentId: maya,
      type: 'credential.superseded',
      payload: {
        credentialId: only,
        label: 'Linear service token',
        sourceId: ownerSource,
        page: 'Owner runbook page',
        surfaceIds: [linear],
      },
      createdAt: 1,
    });
    await ctx.db.insert('workItems', {
      ...workItemFields(maya, 'REVOPS-1'),
      state: 'plan-pending',
    });
    const transferId = await ctx.db.insert('managerTransfers', {
      agentId: maya,
      agentName: 'Maya',
      fromOwnerKey: 'owner',
      fromAddress: MANAGER_ADDRESS,
      toAddress: COLLEAGUE_ADDRESS,
      note: 'Maya owns the RevOps queue.',
      state: 'asked',
      requestedAt: Date.now(),
      expiresAt: transferExpiresAt(Date.now()),
    });
    return {
      maya,
      tomas,
      priya,
      transferId,
      charterId,
      ownerSource,
      colleagueSource,
      only,
      shared,
      linear,
      slack,
      tomasSlack,
    };
  });
  return { harness, ...seeded };
}

/** Accept the office's request as the colleague. */
async function acceptAsColleague(
  office: Office,
  args: { zone?: string; excludedDocSourceIds?: Id<'docSources'>[] } = {},
): Promise<{ agentId: Id<'agents'>; state: 'accepted' | 'accepting' }> {
  return await office.harness
    .withIdentity(COLLEAGUE)
    .mutation(api.transferAcceptance.accept, { transferId: office.transferId, ...args });
}

/** Read one row back. */
async function read<Table extends 'agents' | 'managerTransfers' | 'surfaces' | 'credentials'>(
  harness: Harness,
  id: Id<Table>,
): Promise<Doc<Table> | null> {
  return await harness.run(async (ctx) => (await ctx.db.get(id)) as Doc<Table> | null);
}

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

describe('transferPreview: what the named manager reads before accepting (transfer plan 6.1)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  it('answers the employee, the request, what comes and what does not, and writes nothing', async (): Promise<void> => {
    const office = await seedOffice();
    const before = await office.harness.run(
      async (ctx) => await ctx.db.query('surfaces').collect(),
    );

    const preview = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.transferAcceptance.transferPreview, { transferId: office.transferId });

    expect(preview).toMatchObject({
      mode: 'real',
      employee: { agentId: office.maya, name: 'Maya', state: 'active' },
      fromAddress: MANAGER_ADDRESS,
      note: 'Maya owns the RevOps queue.',
      takesOn: {
        waiting: {
          oneToOne: 0,
          charter: 0,
          plan: 1,
          held: 0,
          skill: 0,
          parked: 0,
          stopped: 0,
          surface: 0,
        },
        openWork: 1,
        openWorkAtLeast: false,
        registeredSkills: 0,
        charter: { version: '0.1', approved: true },
        recordLength: 1,
        recordAtLeast: false,
      },
      leavesBehind: {
        mirroredPages: 1,
        mirroredPagesAtLeast: false,
        autonomousActions: true,
        scopesRevoked: ['linear:read'],
      },
      reportingLines: [REPORTING_LINE],
      documentation: [{ sourceId: office.colleagueSource, label: 'Colleague handbook' }],
      runsInFlight: 0,
    });
    expect(preview?.employee.roleLine).toEqual(expect.any(String));
    expect(preview?.takesOn.scopes).toEqual(
      expect.arrayContaining([{ scope: 'linear:write', source: 'manager' }]),
    );
    expect(preview?.takesOn.scopes.map((grant) => grant.scope)).not.toContain('linear:read');
    expect(preview?.leavesBehind.surfaces).toEqual(
      expect.arrayContaining([
        { slug: 'linear', displayName: 'Linear' },
        { slug: 'slack', displayName: 'Slack' },
      ]),
    );
    expect(JSON.stringify(preview)).not.toContain('Owner handbook');
    expect(
      await office.harness.run(async (ctx) => await ctx.db.query('surfaces').collect()),
    ).toEqual(before);
  });

  it('lists a card that keeps its own identity for re-approval, and counts its read scope among the revoked (join 10)', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      const connectionId = await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'per-employee',
        scopes: ['read', 'write', 'app:assignable'],
        registeredBy: { via: 'setup-cli', at: 1 },
        status: 'active',
        createdAt: 1,
      });
      const own = await ctx.db.insert('credentials', {
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        kind: 'oauth',
        label: 'Day0 Maya access token',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'oauth',
        issuedBy: {
          system: 'linear',
          grant: 'authorisation-code',
          organisationConnectionId: connectionId,
        },
        createdAt: 1,
      });
      await ctx.db.patch(office.linear, {
        credentialId: own,
        credentialKind: 'oauth',
        organisationConnectionId: connectionId,
        actsAs: { kind: 'own-app', label: 'Day0 Maya' },
      });
    });

    const preview = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.transferAcceptance.transferPreview, { transferId: office.transferId });

    expect(preview?.leavesBehind.reapprove).toEqual([
      { slug: 'linear', displayName: 'Linear', identity: 'Day0 Maya', kind: 'own-app' },
    ]);
    expect(preview?.leavesBehind.surfaces).toEqual([{ slug: 'slack', displayName: 'Slack' }]);
    expect(preview?.leavesBehind.scopesRevoked).toEqual(['linear:read']);
    expect(preview?.takesOn.scopes.map((grant) => grant.scope)).not.toContain('linear:read');
  });

  it('counts the record at most to the retire preview’s bound, and says when the count is a floor', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      for (let index = 0; index < 210; index += 1) {
        await ctx.db.insert('events', {
          agentId: office.maya,
          type: 'agent.zone-changed',
          payload: { from: 'UTC', to: 'Europe/London' },
          createdAt: index,
        });
      }
    });

    const preview = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.transferAcceptance.transferPreview, { transferId: office.transferId });

    expect(preview?.takesOn).toMatchObject({ recordLength: 200, recordAtLeast: true });
  });

  it('counts open work by state, however much closed work sits before it', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      for (let index = 0; index < 210; index += 1) {
        await ctx.db.insert('workItems', {
          ...workItemFields(office.maya, `DONE-${index}`),
          state: 'completed',
        });
      }
      await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'NEW-1'),
        state: 'deferred',
      });
    });

    const preview = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.transferAcceptance.transferPreview, { transferId: office.transferId });

    expect(preview?.takesOn).toMatchObject({ openWork: 2, openWorkAtLeast: false });
  });

  it('names an employee stored before the deploy bounded names in 80 characters', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.maya, { name: `Maya\u202E ${'y'.repeat(900_000)}` });
    });

    const preview = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.transferAcceptance.transferPreview, { transferId: office.transferId });

    expect(preview?.employee.name).toBe(`Maya ${'y'.repeat(75)}`);
  });

  it('answers nothing for an asked request past its expiry, which accept would refuse', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.transferId, { expiresAt: Date.now() - 1 });
    });
    await expect(
      office.harness
        .withIdentity(COLLEAGUE)
        .query(api.transferAcceptance.transferPreview, { transferId: office.transferId }),
    ).resolves.toBeNull();
  });

  it('refuses an account the request does not name', async (): Promise<void> => {
    const office = await seedOffice();
    await expect(
      office.harness
        .withIdentity(managerIdentity('bystander'))
        .query(api.transferAcceptance.transferPreview, { transferId: office.transferId }),
    ).rejects.toMatchObject({ data: TRANSFER_NOT_FOUND });
  });

  it('reads a link naming no request, or another table’s row, as one that does not exist (U4-m1)', async (): Promise<void> => {
    const office = await seedOffice();
    for (const transferId of ['garbage', office.maya as string]) {
      await expect(
        office.harness
          .withIdentity(COLLEAGUE)
          .query(api.transferAcceptance.transferPreview, { transferId }),
        transferId,
      ).rejects.toMatchObject({ data: TRANSFER_NOT_FOUND });
    }
  });

  it('answers nothing for a request that is no longer waiting for an answer', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.transferId, { state: 'declined', decidedAt: 2 });
    });
    await expect(
      office.harness
        .withIdentity(COLLEAGUE)
        .query(api.transferAcceptance.transferPreview, { transferId: office.transferId }),
    ).resolves.toBeNull();
  });

  it('gives the named manager nothing of the employee beyond the preview before they accept (14.1 item 1)', async (): Promise<void> => {
    const office = await seedOffice();
    const colleague = office.harness.withIdentity(COLLEAGUE);

    await expect(colleague.query(api.agents.get, { agentId: office.maya })).rejects.toMatchObject({
      data: EMPLOYEE_NOT_YOURS,
    });
    await expect(colleague.query(api.mock.listDocs, { agentId: office.maya })).rejects.toThrow();
    const roster = await colleague.query(api.agents.rosterForUser, {});
    expect(roster.map((row) => row.name)).toEqual(['Priya']);
  });
});

describe('accept in mock mode: the office moves and nothing is kept (14.1 items 1 and 9)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    // The jobs a move schedules run only when a test drains them, never mid-test.
    vi.useFakeTimers();
  });

  it('makes the employee the colleague’s and no longer the asker’s, everywhere either reads it', async (): Promise<void> => {
    vi.useFakeTimers();
    const office = await seedOffice();

    await expect(acceptAsColleague(office, { zone: 'Asia/Singapore' })).resolves.toEqual({
      agentId: office.maya,
      state: 'accepted',
    });

    const owner = office.harness.withIdentity(OWNER);
    const colleague = office.harness.withIdentity(COLLEAGUE);
    await expect(owner.query(api.agents.get, { agentId: office.maya })).rejects.toMatchObject({
      data: EMPLOYEE_NOT_YOURS,
    });
    expect((await owner.query(api.agents.rosterForUser, {})).map((row) => row.name)).toEqual([
      'Tomas',
    ]);
    expect(
      (await owner.query(api.work.needsYou, {})).waitingByEmployee.map((entry) => entry.agentId),
    ).not.toContain(office.maya);
    expect(await colleague.query(api.agents.get, { agentId: office.maya })).toMatchObject({
      userId: 'colleague',
      bossEmail: COLLEAGUE_ADDRESS,
      zone: 'Asia/Singapore',
    });
    const moved = await read(office.harness, office.maya);
    expect(moved?.autonomousActions).toBeUndefined();
    expect(moved?.managerNotifications).toBeUndefined();
    expect(
      (await colleague.query(api.agents.rosterForUser, {})).map((row) => row.name).sort(),
    ).toEqual(['Maya', 'Priya']);
  });

  it('records the move on the request and in the employee’s record, and renders the identity for the new manager', async (): Promise<void> => {
    vi.useFakeTimers();
    const office = await seedOffice();

    await acceptAsColleague(office);

    expect(await read(office.harness, office.transferId)).toMatchObject({
      state: 'accepted',
      decidedAt: expect.any(Number),
      toOwnerKey: 'colleague',
      outcome: { workItemsMoved: 1, charterDiscarded: false },
    });
    const events = await office.harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', office.maya))
          .collect(),
    );
    expect(events.find((event) => event.type === 'manager.transferred')?.payload).toMatchObject({
      transferId: office.transferId,
      fromAddress: MANAGER_ADDRESS,
      toAddress: COLLEAGUE_ADDRESS,
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['agent.autonomy-changed', 'agent.notifications-changed']),
    );
    const identity = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.workspace.read, { agentId: office.maya });
    expect(identity['IDENTITY.md']).toContain(`- ${COLLEAGUE_ADDRESS}`);
    expect(identity['IDENTITY.md']).not.toContain(MANAGER_ADDRESS);
    expect(identity['USER.md']).toBe(`# USER\n\nBoss: ${COLLEAGUE_ADDRESS}\n`);
  });

  it('gives the employee the documentation the acceptor ticked, and counts every old page deleted across pages', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert('mockDocs', {
          agentId: office.maya,
          slug: `owner-page-${index}`,
          title: `Owner page ${index}`,
          body: 'OWNER-PAGE-BODY',
          category: 'team-doc',
          sourceId: office.ownerSource,
          sourceRef: `page-${index}.md`,
          updatedAt: 1,
        });
      }
    });

    await acceptAsColleague(office, { excludedDocSourceIds: [office.colleagueSource] });
    await office.harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await read(office.harness, office.maya))?.excludedDocSourceIds).toEqual([
      office.colleagueSource,
    ]);
    expect((await read(office.harness, office.transferId))?.outcome?.mirroredPagesHidden).toBe(151);
  });

  it('carries the hosted office, hides the old owner’s pages at once, deletes them, and keeps no boundary', async (): Promise<void> => {
    vi.useFakeTimers();
    const office = await seedOffice();

    await acceptAsColleague(office);

    const colleague = office.harness.withIdentity(COLLEAGUE);
    expect(
      (await colleague.query(api.mock.listDocs, { agentId: office.maya })).map((doc) => doc.slug),
    ).toEqual(['office-welcome']);
    await office.harness.finishAllScheduledFunctions(vi.runAllTimers);
    const stored = await office.harness.run(async (ctx) => ({
      docs: (await ctx.db.query('mockDocs').collect()).map((doc) => doc.slug),
      tickets: (await ctx.db.query('mockTickets').collect()).map((ticket) => ticket.agentId),
      retirements: await ctx.db.query('retirements').collect(),
    }));
    expect(stored.docs).toEqual(['office-welcome']);
    expect(stored.tickets).toEqual([office.maya]);
    expect(stored.retirements).toEqual([]);
    expect((await read(office.harness, office.transferId))?.outcome?.mirroredPagesHidden).toBe(1);
  });
});

describe('accept in real mode: two surfaces, one credential shared with a colleague (14.1 items 2 and 3)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    // The jobs a move schedules run only when a test drains them, never mid-test.
    vi.useFakeTimers();
  });

  it('cuts both surfaces, revokes the credential only she bound and keeps the shared one for the old owner', async (): Promise<void> => {
    const office = await seedOffice();

    await acceptAsColleague(office);

    const [linear, slack, tomasSlack, only, shared] = await Promise.all([
      read(office.harness, office.linear),
      read(office.harness, office.slack),
      read(office.harness, office.tomasSlack),
      read(office.harness, office.only),
      read(office.harness, office.shared),
    ]);
    for (const surface of [linear, slack]) {
      expect(surface).toMatchObject({ verdict: 'proposed', reason: HANDOVER_CUT_REASON });
      expect(surface?.credentialId).toBeUndefined();
      expect(surface?.managerUserId).toBeUndefined();
    }
    expect(only?.revokedAt).toEqual(expect.any(Number));
    expect(only?.ciphertext).toBeUndefined();
    expect(shared).toMatchObject({ ciphertext: 'sealed' });
    expect(shared?.revokedAt).toBeUndefined();
    expect(tomasSlack).toMatchObject({ verdict: 'connected', credentialId: office.shared });
    const [departure] = await office.harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    expect(departure).toMatchObject({
      userId: 'owner',
      kind: 'transferred',
      transferId: office.transferId,
      agentId: office.maya,
      agentName: 'Maya',
      revokedCredentials: 1,
      keptCredentials: 1,
    });
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      surfacesCut: 2,
      credentialsRevoked: 1,
      credentialsKept: 1,
      scopesRevoked: 1,
    });
  });

  it('leaves no surface of the employee naming a credential of the old owner’s', async (): Promise<void> => {
    const office = await seedOffice();

    await acceptAsColleague(office);

    const named = await office.harness.run(async (ctx) => {
      const surfaces = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', office.maya))
        .collect();
      const ids = surfaces.flatMap((surface) => [
        ...(surface.credentialId ? [surface.credentialId] : []),
        ...(surface.provisioning ? [surface.provisioning.clientSecretCredentialId] : []),
      ]);
      return await Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.userId));
    });
    expect(named).not.toContain('owner');
  });

  it('gives the new owner no query that answers a mirrored page, a quote, a credential label or a source label of the old owner’s', async (): Promise<void> => {
    const office = await seedOffice();
    await acceptAsColleague(office);
    const colleague = office.harness.withIdentity(COLLEAGUE);
    const agentId = office.maya;

    const answers: unknown[] = await Promise.all([
      colleague.query(api.agents.get, { agentId }),
      colleague.query(api.surfaces.listForAgent, { agentId }),
      colleague.query(api.mock.listDocs, { agentId }),
      colleague.query(api.mock.getDoc, { agentId, slug: 'owner-runbook' }),
      colleague.query(api.events.recent, { agentId }),
      colleague.query(api.events.record, {
        agentId,
        paginationOpts: { numItems: 200, cursor: null },
      }),
      colleague.query(api.agents.recentEvents, { agentId }),
      colleague.query(api.memoryProjection.forAgent, { agentId }),
      colleague.query(api.workspace.read, { agentId }),
      colleague.query(api.agents.permissionScopes, { agentId }),
      colleague.query(api.work.listForAgent, { agentId }),
      colleague.query(api.charters.latest, { agentId }),
      colleague.query(api.voice.latest, { agentId }),
      colleague.query(api.voice.list, { agentId }),
      colleague.query(api.charters.transcriptOf, { charterId: office.charterId }),
      colleague.query(internal.events.exportHead, { agentId, exportedAt: Date.now() }),
      colleague.query(internal.events.exportPage, { agentId, section: 'surfaces', cursor: null }),
      colleague.query(internal.events.exportPage, { agentId, section: 'events', cursor: null }),
    ]);

    const serialised = JSON.stringify(answers);
    for (const secret of OWNER_SECRETS) expect(serialised, secret).not.toContain(secret);
  });

  it('tells the new owner whose one-to-one the carried charter was drafted from, and keeps the session finished', async (): Promise<void> => {
    const office = await seedOffice();
    const before = await office.harness
      .withIdentity(OWNER)
      .query(api.charters.transcriptOf, { charterId: office.charterId });
    await acceptAsColleague(office);

    await expect(
      office.harness
        .withIdentity(COLLEAGUE)
        .query(api.charters.transcriptOf, { charterId: office.charterId }),
    ).resolves.toEqual({ heldBy: MANAGER_ADDRESS });
    expect(before).toMatchObject({ transcript: expect.stringContaining('OWNER-ONE-TO-ONE-TURN') });
    await expect(
      office.harness.withIdentity(COLLEAGUE).query(api.voice.latest, { agentId: office.maya }),
    ).resolves.toMatchObject({ state: 'done', charterId: office.charterId, answers: {} });
  });

  it('cancels the pending jobs that name a cut surface and keeps a colleague’s', async (): Promise<void> => {
    vi.useFakeTimers();
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.scheduler.runAfter(60_000, internal.surfaceActions.probeInternal, {
        surfaceId: office.linear,
      });
      await ctx.scheduler.runAfter(60_000, internal.surfaceActions.probeInternal, {
        surfaceId: office.tomasSlack,
      });
    });

    await acceptAsColleague(office);

    const jobs = await office.harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    const stateOf = (surfaceId: Id<'surfaces'>): string[] =>
      jobs
        .filter((job) => (job.args[0] as { surfaceId?: string }).surfaceId === surfaceId)
        .map((job) => job.state.kind);
    expect(stateOf(office.linear)).toEqual(['canceled']);
    expect(stateOf(office.tomasSlack)).toEqual(['pending']);
  });
});

describe('claims and the departure boundary at a move (14.1 item 4)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    // The jobs a move schedules run only when a test drains them, never mid-test.
    vi.useFakeTimers();
  });

  it('keeps a written claim binding the old owner’s employees and moves it to bind the new owner’s', async (): Promise<void> => {
    const office = await seedOffice();
    const { tomasAsks, priyaAsks } = await office.harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-7'),
        state: 'completed',
      });
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-7',
        agentId: office.maya,
        workItemId: held,
        claimedAt: 1,
      });
      const tomasAsks = await ctx.db.insert('workItems', {
        ...workItemFields(office.tomas, 'REVOPS-7'),
        state: 'discovered',
      });
      const priyaAsks = await ctx.db.insert('workItems', {
        ...workItemFields(office.priya, 'REVOPS-7'),
        state: 'discovered',
      });
      return { tomasAsks, priyaAsks };
    });

    await acceptAsColleague(office);

    const [departure] = await office.harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    expect(departure.claims).toMatchObject([{ key: 'linear:REVOPS-7', state: 'completed' }]);
    const claim = { decision: 'claim', value: 1, risk: 0, requiredPermissions: [] };
    await office.harness.mutation(internal.work.setVerdict, {
      workItemId: tomasAsks,
      verdict: claim,
    });
    await office.harness.mutation(internal.work.setVerdict, {
      workItemId: priyaAsks,
      verdict: claim,
    });
    const [tomasRow, priyaRow] = await Promise.all([
      office.harness.run(async (ctx) => await ctx.db.get(tomasAsks)),
      office.harness.run(async (ctx) => await ctx.db.get(priyaAsks)),
    ]);
    expect(tomasRow).toMatchObject({
      state: 'skipped',
      skipReason: expect.stringContaining('Maya (handed over to another manager) holds it'),
    });
    expect(priyaRow).toMatchObject({
      state: 'skipped',
      skipReason: expect.stringContaining('Maya holds it'),
    });
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      claimsMoved: 1,
      conflictingClaimKeys: [],
    });
  });

  it('closes the old owner’s departure boundary when the employee is handed back to them (U3-m6)', async (): Promise<void> => {
    const office = await seedOffice();
    const tomasAsks = await office.harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-7'),
        state: 'completed',
      });
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-7',
        agentId: office.maya,
        workItemId: held,
        claimedAt: 1,
      });
      return await ctx.db.insert('workItems', {
        ...workItemFields(office.tomas, 'REVOPS-7'),
        state: 'discovered',
      });
    });
    await acceptAsColleague(office);
    const back = await office.harness.run(
      async (ctx) =>
        await ctx.db.insert('managerTransfers', {
          agentId: office.maya,
          agentName: 'Maya',
          fromOwnerKey: 'colleague',
          fromAddress: COLLEAGUE_ADDRESS,
          toAddress: MANAGER_ADDRESS,
          state: 'asked',
          requestedAt: Date.now(),
          expiresAt: transferExpiresAt(Date.now()),
        }),
    );

    await office.harness
      .withIdentity(OWNER)
      .mutation(api.transferAcceptance.accept, { transferId: back });

    const departures = await office.harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    const ownersFirst = departures.find(
      (row) => row.userId === 'owner' && row.transferId === office.transferId,
    );
    expect(ownersFirst).toMatchObject({ kind: 'transferred', claims: [], rejections: [] });
    await office.harness.mutation(internal.work.setVerdict, {
      workItemId: tomasAsks,
      verdict: { decision: 'claim', value: 1, risk: 0, requiredPermissions: [] },
    });
    expect(await office.harness.run(async (ctx) => await ctx.db.get(tomasAsks))).toMatchObject({
      state: 'skipped',
      skipReason: expect.stringContaining('Maya holds it'),
    });
  });

  it('releases a moving claim the new owner already holds, names it in the outcome, and keeps the old owner’s copy', async (): Promise<void> => {
    const office = await seedOffice();
    const moving = await office.harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-8'),
        state: 'completed',
      });
      const moving = await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-8',
        agentId: office.maya,
        workItemId: held,
        claimedAt: 1,
      });
      const priyaHolds = await ctx.db.insert('workItems', {
        ...workItemFields(office.priya, 'REVOPS-8'),
        state: 'executing',
      });
      await ctx.db.insert('externalClaims', {
        userId: 'colleague',
        key: 'linear:REVOPS-8',
        agentId: office.priya,
        workItemId: priyaHolds,
        claimedAt: 1,
      });
      return moving;
    });

    await acceptAsColleague(office);

    expect(await office.harness.run(async (ctx) => await ctx.db.get(moving))).toMatchObject({
      userId: 'owner',
      releasedAt: expect.any(Number),
    });
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      claimsMoved: 0,
      conflictingClaimKeys: ['linear:REVOPS-8'],
    });
    const [departure] = await office.harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    expect(departure.claims.map((kept) => kept.key)).toEqual(['linear:REVOPS-8']);
  });

  it('keeps the claim of open work for the employee under its new owner, frees the item for the old owner’s employees, and keeps the rejections', async (): Promise<void> => {
    const office = await seedOffice();
    const { claim, tomasAsks, priyaAsks } = await office.harness.run(async (ctx) => {
      const planned = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-9'),
        state: 'plan-pending',
        planRejectedAt: 5,
      });
      const claim = await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-9',
        agentId: office.maya,
        workItemId: planned,
        claimedAt: 1,
      });
      const tomasAsks = await ctx.db.insert('workItems', {
        ...workItemFields(office.tomas, 'REVOPS-9'),
        state: 'discovered',
      });
      const priyaAsks = await ctx.db.insert('workItems', {
        ...workItemFields(office.priya, 'REVOPS-9'),
        state: 'discovered',
      });
      return { claim, tomasAsks, priyaAsks };
    });

    await acceptAsColleague(office);

    const kept = await office.harness.run(async (ctx) => await ctx.db.get(claim));
    expect(kept?.userId).toBe('colleague');
    expect(kept?.releasedAt).toBeUndefined();
    const verdict = { decision: 'claim', value: 1, risk: 0, requiredPermissions: [] };
    await office.harness.mutation(internal.work.setVerdict, { workItemId: priyaAsks, verdict });
    await office.harness.mutation(internal.work.setVerdict, { workItemId: tomasAsks, verdict });
    const [priyaRow, tomasRow] = await Promise.all([
      office.harness.run(async (ctx) => await ctx.db.get(priyaAsks)),
      office.harness.run(async (ctx) => await ctx.db.get(tomasAsks)),
    ]);
    expect(priyaRow).toMatchObject({
      state: 'skipped',
      skipReason: expect.stringContaining('Maya holds it'),
    });
    expect(tomasRow?.state).not.toBe('skipped');
    const [departure] = await office.harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    expect(departure.claims).toEqual([]);
    expect(departure.rejections).toMatchObject([{ keys: ['linear:REVOPS-9'], rejectedAt: 5 }]);
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      claimsMoved: 1,
      claimsReleased: 0,
    });
  });

  it('releases the claim of closed work that wrote nothing', async (): Promise<void> => {
    const office = await seedOffice();
    const claim = await office.harness.run(async (ctx) => {
      const cancelled = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-11'),
        state: 'cancelled',
      });
      return await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-11',
        agentId: office.maya,
        workItemId: cancelled,
        claimedAt: 1,
      });
    });

    await acceptAsColleague(office);

    expect(await office.harness.run(async (ctx) => await ctx.db.get(claim))).toMatchObject({
      userId: 'owner',
      releasedAt: expect.any(Number),
    });
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      claimsMoved: 0,
      claimsReleased: 1,
    });
  });

  it('keeps the claim of a stopped item whose write’s outcome is unknown, as one that may have written (M4)', async (): Promise<void> => {
    const office = await seedOffice();
    const claim = await office.harness.run(async (ctx) => {
      const stopped = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-12'),
        state: 'failed',
        output: {
          actions: [{ tool: 'linear.save_comment', args: { issueId: 'REVOPS-12', body: 'Done.' } }],
          applied: [
            {
              tool: 'linear.save_comment',
              ok: false,
              outcomeUnknown: true,
              reason: OUTCOME_UNKNOWN_REASON,
            },
          ],
        },
      });
      return await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-12',
        agentId: office.maya,
        workItemId: stopped,
        claimedAt: 1,
      });
    });

    await acceptAsColleague(office);

    const kept = await office.harness.run(async (ctx) => await ctx.db.get(claim));
    expect(kept?.releasedAt).toBeUndefined();
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      claimsReleased: 0,
    });
  });

  it('finds a key the new owner holds under another of its names', async (): Promise<void> => {
    const office = await seedOffice();
    const moving = await office.harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-10'),
        state: 'completed',
      });
      const moving = await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-10',
        agentId: office.maya,
        workItemId: held,
        claimedAt: 1,
      });
      const priyaHolds = await ctx.db.insert('workItems', {
        ...workItemFields(office.priya, 'lin-uuid-10'),
        externalClaimAlias: 'linear:REVOPS-10',
        state: 'executing',
      });
      await ctx.db.insert('externalClaims', {
        userId: 'colleague',
        key: 'linear:lin-uuid-10',
        aliases: ['linear:REVOPS-10'],
        agentId: office.priya,
        workItemId: priyaHolds,
        claimedAt: 1,
      });
      return moving;
    });

    await acceptAsColleague(office);

    expect(await office.harness.run(async (ctx) => await ctx.db.get(moving))).toMatchObject({
      releasedAt: expect.any(Number),
    });
    expect((await read(office.harness, office.transferId))?.outcome).toMatchObject({
      conflictingClaimKeys: ['linear:REVOPS-10'],
    });
  });
});

describe('the acceptance stamp the company figures read (9-U5, D12)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
  });

  it('stamps decidedAt and toOwnerKey at the acceptance, when the request leaves asked', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9, 0));
    const office = await seedOffice();

    await acceptAsColleague(office);

    expect(await read(office.harness, office.transferId)).toMatchObject({
      state: 'accepted',
      decidedAt: Date.UTC(2026, 9, 1, 9, 0),
      toOwnerKey: 'colleague',
    });
  });

  it('never stamps decidedAt again when an accepting request is moved later', async (): Promise<void> => {
    vi.useFakeTimers();
    const acceptedAt = Date.UTC(2026, 9, 1, 9, 0);
    vi.setSystemTime(acceptedAt);
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.transferId, {
        state: 'accepting',
        decidedAt: acceptedAt,
        toOwnerKey: 'colleague',
        toZone: 'Asia/Singapore',
        toExcludedDocSourceIds: [],
        settleBy: acceptedAt + 15 * 60_000,
      });
    });
    vi.setSystemTime(acceptedAt + 10 * 60_000);

    await office.harness.mutation(internal.transferAcceptance.settle, {
      transferId: office.transferId,
    });

    expect(await read(office.harness, office.transferId)).toMatchObject({
      state: 'accepted',
      decidedAt: acceptedAt,
      toOwnerKey: 'colleague',
    });
    expect(await read(office.harness, office.maya)).toMatchObject({
      userId: 'colleague',
      zone: 'Asia/Singapore',
    });
  });

  it('leaves a settled request as it is when the settle runs twice', async (): Promise<void> => {
    const office = await seedOffice();
    await acceptAsColleague(office);
    const accepted = await read(office.harness, office.transferId);

    await expect(
      office.harness.mutation(internal.transferAcceptance.settle, {
        transferId: office.transferId,
      }),
    ).resolves.toBe('not-accepting');

    expect(await read(office.harness, office.transferId)).toEqual(accepted);
  });
});

describe('accept: the refusals, each before anything moves', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    // The jobs a move schedules run only when a test drains them, never mid-test.
    vi.useFakeTimers();
  });

  it('takes the acceptance while a run is in flight, and waits in accepting for it to end (9-U3b)', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.insert('workItems', {
        ...workItemFields(office.maya, 'REVOPS-2'),
        state: 'executing',
      });
    });

    await expect(acceptAsColleague(office)).resolves.toEqual({
      agentId: office.maya,
      state: 'accepting',
    });
    expect(await read(office.harness, office.transferId)).toMatchObject({ state: 'accepting' });
    expect(await read(office.harness, office.maya)).toMatchObject({ userId: 'owner' });
  });

  it('refuses a request whose answer came too late, even before the expiry sweep runs', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.transferId, { expiresAt: Date.now() - 1 });
    });
    await expect(acceptAsColleague(office)).rejects.toMatchObject({
      data: transferStateRefusal('expired'),
    });
  });

  it('refuses a request no longer waiting for an answer', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.transferId, { state: 'cancelled', cancelReason: 'owner' });
    });
    await expect(acceptAsColleague(office)).rejects.toMatchObject({
      data: transferStateRefusal('cancelled'),
    });
  });

  it('refuses a request already accepted and finishing: only its settle moves it', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.transferId, {
        state: 'accepting',
        decidedAt: 2,
        toOwnerKey: 'colleague',
        settleBy: Date.now() + 60_000,
      });
    });
    await expect(acceptAsColleague(office)).rejects.toMatchObject({
      data: transferStateRefusal('accepting'),
    });
    expect(await read(office.harness, office.maya)).toMatchObject({ userId: 'owner' });
  });

  it('refuses a documentation source of someone else’s among the unticked', async (): Promise<void> => {
    const office = await seedOffice();
    await expect(
      acceptAsColleague(office, { excludedDocSourceIds: [office.ownerSource] }),
    ).rejects.toMatchObject({ data: SOURCE_NOT_YOURS });
    expect(await read(office.harness, office.maya)).toMatchObject({ userId: 'owner' });
  });

  it('refuses an employee that no longer belongs to the manager who asked', async (): Promise<void> => {
    const office = await seedOffice();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.maya, { userId: 'someone-else' });
    });
    await expect(acceptAsColleague(office)).rejects.toMatchObject({ data: EMPLOYEE_LEFT_ASKER });
  });

  it('refuses the account that asked, even signed in with the named address', async (): Promise<void> => {
    const office = await seedOffice();
    await expect(
      office.harness
        .withIdentity(managerIdentity('owner', { email: COLLEAGUE_ADDRESS }))
        .mutation(api.transferAcceptance.accept, { transferId: office.transferId }),
    ).rejects.toMatchObject({ data: OWN_TRANSFER });
  });

  it('refuses an account the request does not name', async (): Promise<void> => {
    const office = await seedOffice();
    await expect(
      office.harness
        .withIdentity(managerIdentity('bystander'))
        .mutation(api.transferAcceptance.accept, { transferId: office.transferId }),
    ).rejects.toMatchObject({ data: TRANSFER_NOT_FOUND });
  });
});

describe('the skill library at a move (10-K, K2)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.useFakeTimers();
  });

  /** One version of the old owner's library, written by one of its employees. */
  function versionFields(
    name: string,
    body: string,
    author: { readonly id: Id<'agents'>; readonly name: string },
    readRef: Id<'docSources'>,
  ): Omit<Doc<'skillVersions'>, '_id' | '_creationTime'> {
    return {
      userId: 'owner',
      name,
      description: `${name}, verified.`,
      surfaceClass: name.split('-')[0]!,
      operation: name.split('-').slice(1).join('-'),
      version: 1,
      body,
      smokeTest: 'CASES = []',
      bodyHash: `sha256:${name}`,
      requiredScopes: [],
      harnessTools: [],
      authorAgentId: author.id,
      authorName: author.name,
      readRefs: [{ sourceId: readRef, ref: 'runbook.md', title: 'Owner runbook page' }],
      verifiedAt: 1,
      createdAt: 1,
    };
  }

  it("the mover's versions are copied and no version names the old owner", async (): Promise<void> => {
    const office = await seedOffice();
    const seeded = await office.harness.run(async (ctx) => {
      const mayas = await ctx.db.insert(
        'skillVersions',
        versionFields(
          'kanban-comment-and-close',
          '# Close',
          { id: office.maya, name: 'Maya' },
          office.ownerSource,
        ),
      );
      const tomass = await ctx.db.insert(
        'skillVersions',
        versionFields(
          'chat-thread-reply',
          '# Reply',
          { id: office.tomas, name: 'Tomas' },
          office.ownerSource,
        ),
      );
      const holding = (
        agentId: Id<'agents'>,
        name: string,
        targetSurface: string,
        versionId: Id<'skillVersions'>,
      ): Omit<Doc<'skills'>, '_id' | '_creationTime'> => ({
        agentId,
        name,
        description: `${name}, verified.`,
        body: '# Body',
        sourceType: 'agent-authored',
        state: 'registered',
        targetSurface,
        versionId,
        createdAt: 1,
      });
      const own = await ctx.db.insert(
        'skills',
        holding(office.maya, 'kanban-comment-and-close', 'linear', mayas),
      );
      const adopted = await ctx.db.insert('skills', {
        ...holding(office.maya, 'chat-thread-reply', 'slack', tomass),
        adoptedAt: 2,
      });
      const tomasOwn = await ctx.db.insert(
        'skills',
        holding(office.tomas, 'chat-thread-reply', 'slack', tomass),
      );
      // Due a re-check because the old library has a newer version of it: a chip naming the old
      // library's numbers.
      await ctx.db.patch(adopted, {
        recheckDueAt: 3,
        recheckReason: 'v4 is verified; this runs v1',
      });
      const offered = await ctx.db.insert('skills', {
        ...holding(office.maya, 'kanban-other', 'linear', tomass),
        state: 'proposed',
        versionId: undefined,
        offeredVersionId: tomass,
      });
      return { mayas, tomass, own, adopted, tomasOwn, offered };
    });

    await acceptAsColleague(office);

    const after = await office.harness.run(async (ctx) => ({
      versions: await ctx.db.query('skillVersions').collect(),
      own: await ctx.db.get(seeded.own),
      adopted: await ctx.db.get(seeded.adopted),
      tomasOwn: await ctx.db.get(seeded.tomasOwn),
      offered: await ctx.db.get(seeded.offered),
    }));
    const copies = after.versions.filter((version) => version.userId === 'colleague');
    expect(copies.map((copy) => copy.name).sort()).toEqual([
      'chat-thread-reply',
      'kanban-comment-and-close',
    ]);
    // Every version the moved employee holds is the new owner's, and none names the old owner:
    // not its key, not one of its employees, not a page of its documentation.
    const held = [after.own, after.adopted].map(
      (row) => after.versions.find((version) => version._id === row?.versionId)!,
    );
    for (const version of held) {
      expect(version.userId).toBe('colleague');
      expect(['Tomas', 'Priya']).not.toContain(version.authorName);
      expect([undefined, office.maya]).toContain(version.authorAgentId);
      expect(version.authorAgentId).not.toBe(office.tomas);
      expect(version.readRefs).toEqual([]);
      expect(JSON.stringify(version)).not.toContain(String(office.ownerSource));
    }
    expect(held[0]).toMatchObject({ authorAgentId: office.maya, authorName: 'Maya', version: 1 });
    expect(after.offered?.offeredVersionId).toBeUndefined();
    // The old owner's versions stay with their other holder, no longer naming the mover.
    const mayas = after.versions.find((version) => version._id === seeded.mayas);
    expect(mayas).toMatchObject({ userId: 'owner', authorName: 'Maya' });
    expect(mayas?.authorAgentId).toBeUndefined();
    expect(after.versions.find((version) => version._id === seeded.tomass)).toMatchObject({
      userId: 'owner',
      authorAgentId: office.tomas,
    });
    expect(after.tomasOwn?.versionId).toBe(seeded.tomass);
    // Both of the employee's surfaces were cut, so both of its skills are due a re-check.
    expect(after.own?.recheckReason).toBe(
      'its connection to linear was cut when the employee was handed over',
    );
    // Already due, with a reason naming the old library's numbers: the stamp stays, the reason
    // no longer names them.
    expect(after.adopted).toMatchObject({
      recheckDueAt: 3,
      recheckReason: 'it was due a re-check when the employee was handed over',
    });
    expect(held[1]).toMatchObject({ authorName: 'a colleague under the previous manager' });
    expect(after.tomasOwn?.recheckDueAt).toBeUndefined();
  });
});
