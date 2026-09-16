import { describe, expect, it } from 'vitest';
import { parseSurfaceAction } from '../../../src/surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../../../src/surfaces/types';
import {
  correctionRequested,
  landedWriteLines,
  landedWritesOf,
  reusedLedger,
  writeTarget,
} from '../../../src/work/landed-writes';
import type { LandedWrite, MockAction } from '../../../src/work/types';

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const post = (body: Record<string, unknown>): MockAction => ({
  tool: 'http.request',
  args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{}', body: JSON.stringify(body) },
});
const row = (extra: Partial<AppliedAction> = {}): AppliedAction => ({ tool: 'mcp.call', ok: true, idempotencyKey: `k${Math.random()}`, ...extra });
const parsed = (action: MockAction) => {
  const result = parseSurfaceAction(action);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
};
const slack = { slug: 'slack', class: 'chat', managerDmChannelId: 'D0MANAGER' } as SurfaceRecord;
const linear = { slug: 'linear', class: 'kanban' } as SurfaceRecord;
const surfaces = [slack, linear];

const comment = call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'Audit note, first form.' });
const done = call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' });
const read = call('linear', 'list_issues', { team: 'REVOPS' });
const reply = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: 'Tile at 74%.' });
const dm = post({ channel: 'D0MANAGER', text: 'Done as you asked.' });
const run = { workItemId: 'work', runId: 'retry', actionIndexOffset: 6 };

describe('the writes earlier runs landed', () => {
  it('reads a flattened run, a two-phase run and a carried list, keeping each landed write once and no read, held or failed row', () => {
    const flattened = {
      actions: [read, comment, done],
      applied: [row(), row({ providerId: 'comment-1', idempotencyKey: 'a' }), row({ ok: false, reason: 'transport' })],
    };
    expect(landedWritesOf(flattened).map((write) => write.applied.providerId)).toEqual(['comment-1']);
    const twoPhase = {
      landedWrites: [{ action: comment, applied: row({ providerId: 'comment-1', idempotencyKey: 'a' }) }],
      initial: { actions: [read, comment], applied: [row(), row({ providerId: 'comment-1', idempotencyKey: 'a' })] },
      actions: [done, reply],
      applied: [row({ held: true }), row({ providerId: '1789.2', idempotencyKey: 'b' })],
    };
    expect(landedWritesOf(twoPhase).map((write) => write.applied.providerId)).toEqual(['comment-1', '1789.2']);
    expect(landedWritesOf(undefined)).toEqual([]);
  });

  it('counts a reused row and the row it reused once, and never trims a comment or message row out of the prompt behind untargeted writes', () => {
    // After a retry reused the comment, the row carries the original in landedWrites and the reuse in its own ledger.
    const afterReuse = {
      landedWrites: [{ action: comment, applied: row({ providerId: 'comment-1', idempotencyKey: 'a' }) }],
      actions: [read, comment, done],
      applied: [row(), row({ providerId: 'comment-1', idempotencyKey: 'work:retry:6', reason: 'reused landed comment comment-1: not sent again' }), row({ providerId: 'lin-5' })],
    };
    expect(landedWritesOf(afterReuse).map((write) => write.applied.providerId)).toEqual(['comment-1', 'lin-5']);
    // Thirty browser writes after one comment: the comment is the row the rule is about, and stays.
    const clicks = Array.from({ length: 30 }, (_, index) => ({
      action: call('looker-pipeline-tile', 'browser_click', { element: 'Save', attempt: index }), applied: row({ idempotencyKey: `click-${index}` }),
    }));
    const lines = landedWriteLines([{ action: comment, applied: row({ providerId: 'comment-1' }) }, ...clicks], surfaces);
    expect(lines[1]).toBe('--- Writes earlier runs of this item already landed (31, last 24 shown) ---');
    expect(lines.filter((line) => line.includes('save_comment'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('browser_click'))).toHaveLength(23);
  });

  it('names a comment by its ticket and a message by its channel and thread, and gives the manager DM and a state change no target', () => {
    expect(writeTarget(parsed(comment), comment, surfaces)).toEqual({ key: 'linear|comment|revops-5', kind: 'comment', target: 'REVOPS-5' });
    expect(writeTarget(parsed(reply), reply, surfaces)).toEqual({ key: 'slack|message|C0REVOPS/1789.1', kind: 'message', target: 'C0REVOPS/1789.1' });
    expect(writeTarget(parsed(dm), dm, surfaces)).toBeUndefined();
    expect(writeTarget(parsed(done), done, surfaces)).toBeUndefined();
    expect(writeTarget(parsed(read), read, surfaces)).toBeUndefined();
  });

  it('reads a correction request from the note, not an acceptance or a direction about the ticket', () => {
    expect(correctionRequested('Yes, move REVOPS-5 to Done, I accept check 2 unconfirmed.')).toBe(false);
    expect(correctionRequested('Read REVOPS-7 on Linear with get_issue before you start, then continue.')).toBe(false);
    expect(correctionRequested('Update the ticket state to Done.')).toBe(false);
    expect(correctionRequested('Fix the audit comment: check 3 must be listed as not confirmed too.')).toBe(true);
    expect(correctionRequested('The wording of the note is wrong; rewrite it with the audit line quoted.')).toBe(true);
    expect(correctionRequested(undefined)).toBe(false);
  });

  it('reuses a same-target comment and thread reply from earlier runs, never a state change or a browser write, and lets a rewrite by id through on a correction', () => {
    const click = call('looker-pipeline-tile', 'browser_click', { element: 'Sign in' });
    const sources: LandedWrite[] = [
      { action: comment, applied: row({ providerId: 'comment-1', effect: 'comment-1', idempotencyKey: 'a' }) },
      { action: reply, applied: row({ providerId: '1789.2', idempotencyKey: 'b' }) },
      { action: done, applied: row({ idempotencyKey: 'c' }) },
      { action: click, applied: row({ idempotencyKey: 'd' }) },
    ];
    const rewritten = call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'Audit note, second form.' });
    const byId = call('linear', 'save_comment', { issueId: 'REVOPS-5', id: 'comment-1', body: 'Audit note, second form.' });
    const otherThread = post({ channel: 'C0REVOPS', thread_ts: '1789.9', text: 'Tile at 74%.' });
    const again = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: 'Tile at 74%, audit line read back.' });
    const ledger = reusedLedger([rewritten, again, otherThread, done, dm, click], sources, run, { surfaces });
    expect(ledger[0]).toMatchObject({ ok: true, providerId: 'comment-1', idempotencyKey: 'work:retry:6' });
    expect(ledger[0]?.reason).toBe('reused landed comment comment-1: this target already carries the comment an earlier run of this item landed; not sent again');
    expect(ledger[1]).toMatchObject({ ok: true, providerId: '1789.2', idempotencyKey: 'work:retry:7' });
    expect(ledger[1]?.reason).toContain('reused landed message 1789.2');
    expect(ledger[2]).toBeUndefined();
    // The same Done and the same sign-in click as an earlier run are sent again: the
    // provider's Done is idempotent and the click belongs to this run's session.
    expect(ledger[3]).toBeUndefined();
    expect(ledger[4]).toBeUndefined();
    expect(ledger[5]).toBeUndefined();
    // Identical payloads are reused only for a resumed closing set's previous attempt.
    expect(reusedLedger([done, click], sources, run, { surfaces, identicalPayloads: true })[0]).toMatchObject({ ok: true, reason: 'This closing action already landed in the previous attempt; reused its recorded result.' });
    expect(reusedLedger([call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Cancelled' })], sources, run, { surfaces })).toEqual([undefined]);
    expect(reusedLedger([byId], sources, run, { surfaces, managerFeedback: 'Fix the audit comment: name check 3 too.' })).toEqual([undefined]);
    expect(reusedLedger([byId], sources, run, { surfaces })[0]?.reason).toContain('reused landed comment comment-1');
    expect(reusedLedger([rewritten], [], run, { surfaces })).toEqual([undefined]);
  });

  it('lists each landed write on one bounded line for the prompt, with the rule after them', () => {
    const long = call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'x'.repeat(200) });
    const lines = landedWriteLines([
      { action: comment, applied: row({ providerId: 'comment-1' }) },
      { action: long, applied: row() },
      { action: reply, applied: row({ providerId: '1789.2' }) },
    ], surfaces);
    expect(lines[1]).toBe('--- Writes earlier runs of this item already landed (3) ---');
    expect(lines[3]).toBe('  0. linear · save_comment · REVOPS-5 · provider id comment-1 · "Audit note, first form."');
    expect(lines[4]).toContain(`"${'x'.repeat(160)} ..."`);
    expect(lines[4]).toContain('provider id (none)');
    expect(lines[5]).toBe('  2. slack · POST /chat.postMessage · C0REVOPS/1789.1 · provider id 1789.2 · "Tile at 74%."');
    expect(lines[6]).toContain('rewrite the landed comment with `id` set to its provider id');
    expect(landedWriteLines([], surfaces)).toEqual([]);
    expect(landedWriteLines(undefined)).toEqual([]);
  });

  it('redacts a structural secret a landed body quotes before the excerpt reaches a prompt', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const quoted = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: `Tile refreshed; the export used Authorization: Bearer ${token} for the pull.` });
    const line = landedWriteLines([{ action: quoted, applied: row({ providerId: '1789.2' }) }], surfaces)[3]!;
    expect(line).not.toContain(token);
    expect(line).toContain('<redacted>');
    expect(line).toContain('Tile refreshed');
  });
});
