/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convexTest } from 'convex-test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveSpanModel } from '../fixtures/redaction-double';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { TRACE_SECTIONS } from '../../src/export/trace';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { temporaryDirectories } from '../setup/temporary-directories';

/*
 * Cross-unit test 4 of the access plan (section 8; the wave 11 file): no organisation secret in
 * any stored text, event, export or prompt. The secret IT landed for the organisation is written
 * into a documentation page an owner links; the page is synced and the documentation's systems
 * discovered as the product does it, and the secret is in neither the pages stored, the prompt
 * the model is sent, nor any section of the employee's export (the wave 11 review's M11 d).
 */

const temporary = temporaryDirectories();

/** A client secret no structural rule recognises: only the exact-value layer removes it. */
const ORGANISATION_SECRET = 'Quiet-Harbour-73';

/** Words of the page that are not secret, so a prompt is shown to carry the page at all. */
const PAGE_WORDS = 'The revenue team files every request in the Linear queue';

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

/** Every prompt the product sent the model, as the call carried it. */
const prompts: string[] = [];

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked((call) => {
    prompts.push(call.user);
    return { systems: [] };
  }),
}));

// The redaction component the sync reaches through DAY0_REDACTOR_URL, served in-process from the
// recorded span model.
let redactorDouble: { url: string; close: () => Promise<void> } | undefined;
beforeAll(async (): Promise<void> => {
  redactorDouble = await serveSpanModel();
  process.env.DAY0_REDACTOR_URL = redactorDouble.url;
});
afterAll(async (): Promise<void> => {
  delete process.env.DAY0_REDACTOR_URL;
  await redactorDouble?.close();
});

beforeEach((): void => {
  prompts.length = 0;
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe("no organisation secret in any stored text, prompt or export (cross-unit test 4, the review's M11 d)", (): void => {
  it('keeps the secret IT landed out of the pages stored, the prompt the model reads and every section of the export', async (): Promise<void> => {
    const root = temporary('day0-organisation-secret-');
    await mkdir(join(root, 'revops'));
    await writeFile(
      join(root, 'revops', 'tickets.md'),
      `# Tickets\n\n${PAGE_WORDS}. The integration's client secret is ${ORGANISATION_SECRET}.\n`,
      'utf8',
    );
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    await harness.action(internal.organisationConnections.landFromSetup, {
      system: 'linear',
      displayName: 'Linear',
      kind: 'oauth-app',
      mode: 'shared',
      scopes: ['read'],
      clientCredentialsScopes: ['read'],
      clientId: 'lin-client-1',
      secret: ORGANISATION_SECRET,
    });
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Revops',
      kind: 'folder',
      locator: 'revops',
    });

    await expect(
      harness.action(internal.docSyncActions.syncSource, { sourceId }),
    ).resolves.toMatchObject({ ok: true, pages: 1, complete: true });
    // The sync schedules the discovery of the documentation's systems; it is run here, in order.
    const [run] = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docSyncRuns')
          .filter((row) => row.eq(row.field('sourceId'), sourceId))
          .collect(),
    );
    await harness.action(internal.documentationDiscoveryActions.discoverSource, {
      sourceId,
      runId: run!._id,
    });
    await harness.finishInProgressScheduledFunctions();

    const stored = await harness.run(async (ctx) => ({
      pages: await ctx.db.query('docPages').collect(),
      events: await ctx.db.query('events').collect(),
    }));
    expect(stored.pages.map((page) => page.markdown).join('\n')).toContain(PAGE_WORDS);
    expect(JSON.stringify(stored)).not.toContain(ORGANISATION_SECRET);

    expect(prompts.some((prompt) => prompt.includes(PAGE_WORDS))).toBe(true);
    for (const prompt of prompts) expect(prompt).not.toContain(ORGANISATION_SECRET);

    for (const section of TRACE_SECTIONS) {
      const page = await harness
        .withIdentity(managerIdentity())
        .action(api.exportActions.exportPage, { agentId, section, cursor: null });
      expect(JSON.stringify(page.rows), section).not.toContain(ORGANISATION_SECRET);
    }
  });
});
