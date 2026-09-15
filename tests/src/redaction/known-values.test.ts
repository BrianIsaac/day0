/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../convex/_generated/api';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import schema from '../../../convex/schema';
import { persistPageBatch } from '../../../convex/docSyncActions';
import { encrypt } from '../../../src/lib/credential-crypto';
import { RedactorUnavailableError, type SpanModel } from '../../../src/redaction/client';
import { ownerValuesRef, scrubKnownValues } from '../../../src/redaction/known-values';
import { redactText } from '../../../src/redaction/redact';
import { HttpAdapter } from '../../../src/surfaces/http';
import { McpAdapter, type McpClientLike, type McpClientOptions } from '../../../src/surfaces/mcp';
import type { AdapterRun, AppliedAction, SurfaceRecord } from '../../../src/surfaces/types';
import { redactGroundingRead } from '../../../src/work/plan';
import type { DocPage } from '../../../src/docs/types';
import type { MockAction } from '../../../src/work/types';
import { allConvexModules } from '../../convex/all-modules';
import { RecordedSpanModel, ScriptedSpanModel, StalledSpanModel, UnreachableSpanModel, serveSpanModel } from '../../fixtures/redaction-double';

/**
 * A value Day0 stored for this owner that no transport in the run holds and
 * that the recorded model does not know: only the exact-value layer, fed by
 * the owner-wide list, can remove it.
 */
const STORED = 'Sunny-Day-42';
const KEY = randomBytes(32).toString('base64');
const now = Date.UTC(2026, 8, 15, 9);
const ctx = {} as ActionCtx;
const run: AdapterRun = {
  agentId: 'agent' as Id<'agents'>,
  agentName: 'Priya',
  workItemId: 'wi' as Id<'workItems'>,
  runId: 'run' as Id<'events'>,
};
const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://mcp.linear.app/mcp',
  path: 'mcp',
  toolAllowlist: ['save_comment'],
  credentialId: 'cred-linear',
  credentialKind: 'value',
};
const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://slack.com/api/',
  path: 'documented-api',
  toolAllowlist: ['chat.postMessage'],
  credentialId: 'cred-slack',
  credentialKind: 'value',
  managerDmChannelId: 'D0MANAGER',
};
const comment: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'Note.' }) },
};
const post: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
  },
};

type SidecarState = 'up' | 'down' | 'timing out';
const STATES: SidecarState[] = ['up', 'down', 'timing out'];

function modelFor(state: SidecarState): SpanModel {
  if (state === 'up') return new RecordedSpanModel();
  if (state === 'down') return new UnreachableSpanModel();
  return new StalledSpanModel();
}

/** The flag a row carries reflects only whether the model layer ran. */
function expectedFlag(state: SidecarState): 'structural-only' | undefined {
  return state === 'up' ? undefined : 'structural-only';
}

function mcpClient(text: string): (options: McpClientOptions) => McpClientLike {
  return (): McpClientLike => ({
    listTools: async () => ({ linear_save_comment: { execute: async (): Promise<unknown> => text } }),
    disconnect: async (): Promise<void> => undefined,
  });
}

/** An action context whose only two actions are the owner list and the credential store. */
function docSyncCtx(known: string[]): { ctx: ActionCtx; actions: unknown[]; mutations: unknown[] } {
  const actions: unknown[] = [];
  const mutations: unknown[] = [];
  const fake = {
    runAction: async (reference: unknown, args: unknown): Promise<unknown> => {
      if (getFunctionName(reference as never) === getFunctionName(ownerValuesRef)) return known;
      actions.push(args);
      return `credential-${actions.length}` as Id<'credentials'>;
    },
    runMutation: async (_reference: unknown, args: unknown): Promise<unknown> => {
      mutations.push(args);
      return undefined;
    },
  } as unknown as ActionCtx;
  return { ctx: fake, actions, mutations };
}

const source: Doc<'docSources'> = {
  _id: 'source-1' as Id<'docSources'>,
  _creationTime: 1,
  userId: 'owner',
  label: 'Runbooks',
  kind: 'folder',
  locator: '.',
  status: 'linking',
  createdAt: 1,
  updatedAt: 1,
};

describe.each(STATES)('an unrelated stored password with the redaction component %s', (state: SidecarState): void => {
  it('never reaches a Linear outcome, and the row is flagged only when the model did not run', async (): Promise<void> => {
    const adapter = new McpAdapter([linear], {
      decrypt: async (): Promise<string> => 'lin-transport-secret',
      createClient: mcpClient(`Comment saved. Reminder from the ticket: the tile password is ${STORED}.`),
      now: (): number => now,
      spanModel: modelFor(state),
      knownValues: [STORED],
    });
    const result = await adapter.apply(ctx, run, comment, 0, 'k');
    expect(result.ok).toBe(true);
    expect(result.effect).not.toContain(STORED);
    expect(result.effect).toContain('<redacted>');
    expect(result.redaction).toBe(expectedFlag(state));
  });

  it('never reaches a Slack provider identifier', async (): Promise<void> => {
    const adapter = new HttpAdapter([slack], {
      decrypt: async (): Promise<string> => 'xoxb-transport-secret',
      fetch: async (): Promise<Response> => Response.json({ ok: true, ts: STORED, message: { text: `echo ${STORED}` } }),
      now: (): number => now,
      spanModel: modelFor(state),
      knownValues: [STORED],
    });
    const result = await adapter.apply(ctx, run, post, 0, 'k');
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('<redacted>');
    expect(result.effect).not.toContain(STORED);
    expect(result.redaction).toBe(expectedFlag(state));
  });

  it('never reaches a synced page: removed when the model runs, nothing persisted when it does not', async (): Promise<void> => {
    const { ctx: fake, actions, mutations } = docSyncCtx([STORED]);
    const page: DocPage = {
      sourceId: source._id,
      ref: 'tile.md',
      title: 'Tile runbook',
      markdown: `# Tile runbook\n\nThe tile password is ${STORED}; ask Priya.\n`,
      updatedAt: 1,
    };
    const persist = persistPageBatch(fake, source, [page], [], modelFor(state));
    if (state === 'up') {
      await expect(persist).resolves.toMatchObject({ pages: 1, redactions: 1 });
      expect(JSON.stringify(mutations)).toContain('<credential: ');
      expect(JSON.stringify(actions)).toContain(STORED);
    } else {
      await expect(persist).rejects.toBeInstanceOf(RedactorUnavailableError);
      expect(mutations).toEqual([]);
    }
    expect(JSON.stringify(mutations)).not.toContain(STORED);
  });

  it('never reaches a grounding record', async (): Promise<void> => {
    const applied: AppliedAction = {
      tool: 'mcp.call',
      ok: true,
      effect: `get_issue on linear · {"description":"Refresh the tile with ${JSON.stringify(STORED).slice(1, -1)}"}`,
      providerId: STORED,
      idempotencyKey: 'k',
    };
    const result = await redactGroundingRead(applied, modelFor(state), [STORED]);
    expect(result.effect).not.toContain(STORED);
    expect(result.providerId).toBe('<redacted>');
    expect(result.redaction).toBe(expectedFlag(state));
  });

  describe('the export', (): void => {
    let served: { url: string; close: () => Promise<void> } | undefined;
    beforeAll(async (): Promise<void> => {
      if (state === 'up') served = await serveSpanModel();
    });
    afterAll(async (): Promise<void> => {
      await served?.close();
    });
    beforeEach((): void => {
      vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
      vi.stubEnv('DAY0_REDACTOR_URL', state === 'up' ? served?.url ?? '' : 'http://127.0.0.1:1');
    });
    afterEach((): void => {
      vi.unstubAllEnvs();
    });

    it('never reaches the export, whichever half asked', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const agentId = await harness.run(async (db): Promise<Id<'agents'>> => {
        const id = await db.db.insert('agents', { bossEmail: 'boss@day0.local', name: 'Priya', userId: 'owner', state: 'active', createdAt: 1 });
        await db.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'Looker tile password',
          source: 'entered',
          createdAt: 1,
          ...encrypt(STORED, KEY),
        });
        await db.db.insert('events', {
          agentId: id,
          type: 'work.completed',
          payload: { effect: `Commented: the tile password is ${STORED}`, nested: [{ url: `https://x?p=${encodeURIComponent(STORED)}` }] },
          createdAt: 2,
        });
        return id;
      });
      const trace = await harness.withIdentity({ subject: 'owner' }).action(api.exportActions.exportForAgent, { agentId });
      const serialised = JSON.stringify(trace);
      expect(serialised).not.toContain(STORED);
      expect(serialised).not.toContain(encodeURIComponent(STORED));
      expect(serialised).toContain('<redacted>');
      expect(trace.credentialNames).toEqual([]);
      await expect(
        harness.withIdentity({ subject: 'intruder' }).action(api.exportActions.exportForAgent, { agentId }),
      ).rejects.toThrow('forbidden');
      await expect(harness.action(api.exportActions.exportForAgent, { agentId })).rejects.toThrow();
    });
  });
});

describe('the exact-value layer inside redactText', (): void => {
  it('turns a known value into a removal span on the original text, in every representation, and masks it from the model', async (): Promise<void> => {
    const value = 'opaque+value/with=chars';
    const text = `raw ${value} · json ${JSON.stringify(value).slice(1, -1)} · url ${encodeURIComponent(value)} · the password is hunter2`;
    const model = new ScriptedSpanModel((): never[] => []);
    const result = await redactText(text, 'outcome', { known: [value], model, onUnavailable: 'structural' });
    expect(result.text).toBe('raw <redacted> · json <redacted> · url <redacted> · the password is hunter2');
    expect(result.degraded).toBeUndefined();
    expect(result.findings.filter((finding) => finding.label === 'known credential')).toHaveLength(3);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.text).not.toContain(value);
    expect(model.calls[0]!.text).toHaveLength(text.length);
  });

  it('lets a structural finding name a known value it also covers', async (): Promise<void> => {
    const token = `xoxb-1234567890-${'aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW'}`;
    const result = await redactText(`Bot token: ${token}`, 'documentation', {
      known: [token],
      model: new ScriptedSpanModel((): never[] => []),
      onUnavailable: 'throw',
    });
    expect(result.text).toBe('Bot token: <redacted>');
    expect(result.findings.map((finding) => finding.label)).toEqual(['slack bot token']);
  });
});

describe('scrubKnownValues', (): void => {
  it('walks every string of a persisted shape and leaves the rest alone', (): void => {
    const value = 'tile-secret-9';
    const shape = {
      count: 2,
      ok: true,
      rows: [{ effect: `set ${value}`, nested: { reason: `${encodeURIComponent('a b/' + value)}` } }, null],
      untouched: 'plain',
    };
    expect(scrubKnownValues(shape, [value, 'a b/' + value])).toEqual({
      count: 2,
      ok: true,
      rows: [{ effect: 'set <redacted>', nested: { reason: '<redacted>' } }, null],
      untouched: 'plain',
    });
    expect(scrubKnownValues(shape, [])).toBe(shape);
  });
});
