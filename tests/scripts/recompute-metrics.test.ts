import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id, TableNames } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { recomputeFromExport, runRecompute } from '../../scripts/recompute-metrics';
import { allConvexModules } from '../convex/all-modules';

const OWNER = 'company-owner';
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A backend holding two employees of one owner and the revocation driver's
 * evaluation agent under the same owner, as a bed would after a trial.
 */
async function companyBackend(): Promise<ReturnType<typeof convexTest>> {
  const harness = convexTest(schema, allConvexModules());
  await harness.run(async (ctx): Promise<void> => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: OWNER,
      kind: 'folder',
      label: 'Company handbook',
      locator: '.',
      status: 'synced',
      createdAt: 500,
      updatedAt: 500,
    });
    await ctx.db.insert('docSyncRuns', {
      sourceId,
      refs: [],
      credentialRefs: [],
      pageCount: 4,
      redactionCount: 0,
      state: 'completed',
      createdAt: 900,
      completedAt: 950,
    });
    const employees = [
      {
        name: 'Priya',
        bossEmail: 'boss@day0.local',
        deployedAt: 1_000,
        approvedAt: 61_000,
        waits: [4_000, 6_000],
      },
      {
        name: 'Mateo',
        bossEmail: 'boss@day0.local',
        deployedAt: 2_000,
        approvedAt: 122_000,
        waits: [30_000],
      },
      {
        name: 'Day0 revocation evaluation',
        bossEmail: 'eval-revocation-2026-09-18t08-00-00z@day0.local',
        deployedAt: 3_000,
        approvedAt: 4_000,
        waits: [900_000],
      },
    ];
    for (const employee of employees) {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: employee.bossEmail,
        name: employee.name,
        userId: OWNER,
        state: 'active',
        arm: 'day0',
        createdAt: employee.deployedAt,
      });
      const addEvent = async (type: string, payload: unknown, createdAt: number): Promise<void> => {
        await ctx.db.insert('events', { agentId, type, payload, createdAt });
      };
      await addEvent('agent.deployed', {}, employee.deployedAt);
      const charterId = await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: {},
        approved: true,
        approvedAt: employee.approvedAt,
        createdAt: employee.deployedAt + 500,
      });
      await addEvent('charter.approved', { charterId }, employee.approvedAt);
      for (const [index, wait] of employee.waits.entries()) {
        const workItemId: Id<'workItems'> = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `${employee.name.slice(0, 5).toUpperCase()}-${index + 1}`,
          title: `${employee.name} item ${index + 1}`,
          contentSummary: 'Synthetic company work.',
          contentRefs: [],
          state: 'completed',
          observedAt: 1,
          createdAt: 1,
        });
        await ctx.db.patch(workItemId, {
          output: {
            applied: [
              {
                tool: 'mcp.call',
                ok: true,
                authority: 'autonomous',
                effect: `Commented on ${employee.name} item ${index + 1}`,
                idempotencyKey: `${workItemId}:run-${index}:0`,
              },
            ],
          },
        });
        const requestedAt = 200_000 + index * 100_000;
        await addEvent(
          'work.decision-requesting',
          { workItemId, decisionId: `${employee.name}-${index}`, kind: 'plan' },
          requestedAt,
        );
        await addEvent(
          'work.plan-approved',
          { workItemId, decidedVia: 'dashboard' },
          requestedAt + wait,
        );
      }
    }
  });
  return harness;
}

/** Write every table of the backend as a Convex snapshot export directory. */
async function exportDirectory(harness: ReturnType<typeof convexTest>): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'day0-recompute-test-'));
  temporary.push(directory);
  const tables = Object.keys(schema.tables) as TableNames[];
  const rows = await harness.run(async (ctx) =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, await ctx.db.query(table).collect()] as const),
      ),
    ),
  );
  writeFileSync(join(directory, 'README.md'), '# Welcome to your Convex snapshot export!\n');
  mkdirSync(join(directory, '_tables'));
  writeFileSync(
    join(directory, '_tables', 'documents.jsonl'),
    tables.map((name, index) => JSON.stringify({ name, id: 10_001 + index })).join('\n'),
  );
  for (const table of tables) {
    mkdirSync(join(directory, table));
    writeFileSync(
      join(directory, table, 'documents.jsonl'),
      // By id, as a Convex snapshot export lists them, not in creation order.
      [...rows[table]]
        .sort((left, right) => (left._id < right._id ? -1 : 1))
        .map((row) => `${JSON.stringify(row)}\n`)
        .join(''),
    );
  }
  return directory;
}

function capture(): {
  io: { log(line: string): void; error(line: string): void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

describe('recomputing the supervision figures from an export', (): void => {
  it('reproduces metrics:forOwner exactly from an export of two employees and an evaluation agent', async (): Promise<void> => {
    const harness = await companyBackend();
    const live = await harness.withIdentity({ subject: OWNER }).query(api.metrics.forOwner, {});
    const directory = await exportDirectory(harness);

    const recomputed = recomputeFromExport(directory, { owner: OWNER });

    expect(recomputed.owner).toBe(OWNER);
    expect(recomputed.figures).toEqual(live);
    // The evaluation agent's fifteen-minute wait is in neither: the old
    // script fed every row of the export to one agent's function.
    expect(recomputed.figures.employees.map((row) => row.name)).toEqual(['Priya', 'Mateo']);
    expect(recomputed.figures.excludedAgents).toBe(1);
    expect(recomputed.figures.company).toMatchObject({
      employees: 2,
      decisions: { requested: 3, approved: 3, medianLatencyMs: 6_000, p90LatencyMs: 30_000 },
      auditTrail: { complete: 3, total: 3, fraction: 1 },
    });
  });

  it('reads the zip Convex writes as it reads the directory', async (): Promise<void> => {
    const directory = await exportDirectory(await companyBackend());
    const archive = join(mkdtempSync(join(tmpdir(), 'day0-recompute-zip-')), 'export.zip');
    temporary.push(resolve(archive, '..'));
    execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: directory });

    expect(recomputeFromExport(archive, { owner: OWNER })).toEqual(
      recomputeFromExport(directory, { owner: OWNER }),
    );
  });

  it('anchors the timeline on the owner’s first documentation sync and names each employee', async (): Promise<void> => {
    const directory = await exportDirectory(await companyBackend());

    const { anchor, timeline } = recomputeFromExport(directory, { owner: OWNER });

    expect(anchor).toEqual({ at: 900, source: 'documentation sync' });
    expect(timeline.map((row) => [row.offsetMs, row.employee, row.type]).slice(0, 4)).toEqual([
      [100, 'Priya', 'agent.deployed'],
      [1_100, 'Mateo', 'agent.deployed'],
      [60_100, 'Priya', 'charter.approved'],
      [121_100, 'Mateo', 'charter.approved'],
    ]);
    expect(timeline.some((row) => row.employee === 'Day0 revocation evaluation')).toBe(false);
  });

  it('orders same-millisecond timeline events by backend write time, not export id', async (): Promise<void> => {
    const directory = await exportDirectory(await companyBackend());
    const agents = readFileSync(join(directory, 'agents', 'documents.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { _id: string; name: string });
    const priyaId = agents.find((row) => row.name === 'Priya')?._id;
    if (!priyaId) throw new Error('synthetic employee absent');
    const eventsPath = join(directory, 'events', 'documents.jsonl');
    const earlier = {
      _id: 'z-earlier', _creationTime: 500_000.1, agentId: priyaId,
      type: 'skill.registered', payload: {}, createdAt: 500_000,
    };
    const later = {
      _id: 'a-later', _creationTime: 500_000.2, agentId: priyaId,
      type: 'skill.failed', payload: {}, createdAt: 500_000,
    };
    writeFileSync(eventsPath, `${readFileSync(eventsPath, 'utf8')}${JSON.stringify(later)}\n${JSON.stringify(earlier)}\n`);

    const { timeline } = recomputeFromExport(directory, { owner: OWNER });
    expect(timeline.filter((row) => row.at === 500_000).map((row) => row.type)).toEqual([
      'skill.registered', 'skill.failed',
    ]);
  });

  it('passes an --expect file that names every field and fails naming each field that differs', async (): Promise<void> => {
    const directory = await exportDirectory(await companyBackend());
    const { figures } = recomputeFromExport(directory, { owner: OWNER });
    const expectations = mkdtempSync(join(tmpdir(), 'day0-recompute-expect-'));
    temporary.push(expectations);
    const exact = join(expectations, 'exact.json');
    writeFileSync(exact, JSON.stringify(figures));
    const wrong = join(expectations, 'wrong.json');
    writeFileSync(
      wrong,
      JSON.stringify({
        company: { decisions: { medianLatencyMs: 5_000 }, auditTrail: { total: 3 } },
        employees: [
          { name: 'Priya' },
          { name: 'Mateo', metrics: { charter: { timeToFirstApprovedMs: 1 } } },
        ],
      }),
    );

    const pass = capture();
    expect(runRecompute([directory, '--owner', OWNER, '--expect', exact], pass.io)).toBe(0);
    expect(pass.out.join('\n')).toContain('"medianLatencyMs": 6000');
    expect(pass.err).toEqual([]);

    const fail = capture();
    expect(runRecompute([directory, '--owner', OWNER, '--expect', wrong], fail.io)).toBe(1);
    expect(fail.err.join('\n')).toContain(
      'company.decisions.medianLatencyMs: expected 5000, got 6000',
    );
    expect(fail.err.join('\n')).toContain(
      'employees.1.metrics.charter.timeToFirstApprovedMs: expected 1, got 120000',
    );
    expect(fail.err.join('\n')).not.toContain('auditTrail');
  });

  it('refuses a path that is not an export and an unknown flag with usage', async (): Promise<void> => {
    const empty = mkdtempSync(join(tmpdir(), 'day0-recompute-empty-'));
    temporary.push(empty);

    const missing = capture();
    expect(runRecompute([empty], missing.io)).toBe(2);
    expect(missing.err.join('\n')).toContain('agents');

    const unknown = capture();
    expect(runRecompute([empty, '--owners', OWNER], unknown.io)).toBe(2);
    expect(unknown.err.join('\n')).toContain('Usage');
  });
});

/**
 * The 17 September recording's export carries the operator's own address, so
 * it lives under the ignored `docs/` tree and is never committed; this reads
 * it where the primary checkout keeps it and is skipped on a fresh clone.
 */
const RECORDING_EXPORT = resolve('docs/plans/progress/recording-run-2026-09-17/export.zip');

describe.skipIf(!existsSync(RECORDING_EXPORT))('the 17 September recording export', (): void => {
  it('reproduces its own Supervision card from the zip', async (): Promise<void> => {
    const { figures, anchor, timeline } = recomputeFromExport(RECORDING_EXPORT);

    expect(figures.employees.map((row) => row.name)).toEqual(['ops worker']);
    expect(figures.excludedAgents).toBe(0);
    // numbers.md, "Supervision card (metrics:forAgent)".
    const card = {
      charter: {
        timesToFirstApprovedMs: [66_924],
        medianTimeToFirstApprovedMs: 66_924,
        approvedEmployees: 1,
      },
      decisions: {
        requested: 2,
        approved: 2,
        rejected: 0,
        partiallyApproved: 0,
        medianLatencyMs: 48_211,
        p90LatencyMs: 48_662,
        byVia: { dashboard: { decided: 2 }, channel: { decided: 0 } },
      },
      actions: {
        autoApplied: 25,
        approved: 1,
        held: 1,
        refused: 0,
        rejected: 0,
        blockedAfterRevocation: null,
      },
      auditTrail: { complete: 26, total: 26, fraction: 1 },
    };
    expect(figures.company).toMatchObject({ employees: 1, ...card });
    expect(figures.employees[0].metrics).toMatchObject({
      charter: { timeToFirstApprovedMs: 66_924 },
      decisions: card.decisions,
      actions: card.actions,
      auditTrail: card.auditTrail,
    });
    // numbers.md, "Timeline": the documentation link at 21:00:22, the deploy
    // at 0:43 and the charter approval at 1:49.
    expect(anchor?.source).toBe('documentation sync');
    expect(new Date(anchor!.at).toISOString()).toBe('2026-09-16T21:00:22.551Z');
    const offset = (type: string): number | undefined =>
      timeline.find((row) => row.type === type)?.offsetMs;
    expect(Math.floor(offset('agent.deployed')! / 1_000)).toBe(43);
    expect(Math.floor(offset('charter.approved')! / 1_000)).toBe(109);
  });
});
