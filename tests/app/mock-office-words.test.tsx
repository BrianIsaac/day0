import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import { LandedChanges, NotSentLedger } from '../../app/agent/[agentId]/work/LandedChanges';
import { mockAdapter } from '../../src/surfaces/mock';
import { HELD_NOT_APPROVED } from '../../src/surfaces/policy';
import { summariseAction } from '../../src/surfaces/summary';
import type { MockAction } from '../../src/work/types';

/**
 * W17-R30, the hosted walk's finding 7 (`hosted-walk-v0.20.0-2026-10-13-handover.md:21`): the
 * mock office's cards printed its internals. Each case draws one card's part as the card draws it,
 * from the walk's own rows (`rows/A-Lark-tB-full.txt`, `A-Pip-tB-full.txt`, `A-Lark-skills.txt`),
 * and reads the markup for the five: a verb's name, a channel or sheet slug, a thread key, a scope
 * string and an input's name, with the reconciliation line an office that has no provider showed.
 */

/** The office's four verbs by name, as the executor emits them. */
const TOOL_NAME = /\b(?:slack\.postMessage|spreadsheet\.appendRow|ticket\.update|twitter\.reply)\b/;
/** The office's slugs: a DM's, the tracker's, the mention's. A channel's `#name` is its name. */
const SLUG = /(?<![#\w-])(?:dm-[a-z]+|q4-revenue-tracker|tweet-acme-feedback|office-asks)\b/;
/** A thread's key. */
const THREAD_KEY = /\bthread-[a-z-]+/;
/** The markup's text as a reader meets it, tags dropped, so a class name is never read as words. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lark's writes on the withheld card (`A-Lark-tB-full.txt`), and Pip's post in Hana's thread. */
const ROW: MockAction = {
  tool: 'spreadsheet.appendRow',
  args: {
    sheetSlug: 'q4-revenue-tracker',
    tabName: 'closed-won',
    cells: [
      { header: 'Account', value: 'Beta Corp' },
      { header: 'Amount', value: '$72,000' },
    ],
  },
};
const TICKET: MockAction = {
  tool: 'ticket.update',
  args: { slug: 'REVOPS-204', status: 'done', comment: 'Logged the three deals.' },
};
const RECAP: MockAction = {
  tool: 'slack.postMessage',
  args: { channelSlug: 'dm-manager', body: 'Logged the three deals and closed REVOPS-204.' },
};
const THREAD_REPLY: MockAction = {
  tool: 'slack.postMessage',
  args: {
    channelSlug: 'office-asks',
    threadKey: 'thread-double-charge',
    body: 'Hi Hana, here is a first reply for Northwind on invoice INV-2207.',
  },
};

/**
 * Apply one write through the office's adapter, the mutation answering that it landed, and return
 * the ledger row the card draws.
 *
 * @param action - The office write.
 */
async function landed(action: MockAction): Promise<{ tool: string; ok: boolean; effect?: string }> {
  const ctx = {
    runMutation: async (): Promise<{ changed: boolean }> => ({ changed: true }),
    scheduler: { runAfter: async (): Promise<void> => undefined },
  } as unknown as ActionCtx;
  const run = {
    agentId: 'agent-1' as Id<'agents'>,
    agentName: 'Pip',
    workItemId: 'item-1' as Id<'workItems'>,
    runId: 'run-1' as Id<'events'>,
  };
  return await mockAdapter.apply(ctx, run, action, 0, 'item-1:run-1:0');
}

describe('the mock office’s cards in a manager’s words (W17-R30)', (): void => {
  it('heads a held write by what it writes and where, never by its verb or a slug', (): void => {
    const rows = [ROW, TICKET, RECAP].map((action) => ({
      tool: action.tool,
      ok: false,
      held: true,
      reason: HELD_NOT_APPROVED,
      summary: summariseAction(action, []),
    }));
    const drawn = text(renderToStaticMarkup(<NotSentLedger rows={rows} />));
    expect(drawn).not.toMatch(TOOL_NAME);
    expect(drawn).not.toMatch(SLUG);
    expect(drawn).toContain('A new row on the spreadsheet’s “closed-won” tab');
    expect(drawn).toContain('Ticket REVOPS-204 moved to done, with a comment');
    expect(drawn).toContain('A message to you in Slack');
  });

  it('says what a landed post did and in whose thread, never the channel’s slug or the thread’s key', async (): Promise<void> => {
    const rows = await Promise.all(
      [THREAD_REPLY, RECAP].map(async (action, place) => ({ ...(await landed(action)), place })),
    );
    const drawn = text(renderToStaticMarkup(<LandedChanges rows={rows} fresh={new Set()} />));
    expect(drawn).not.toMatch(THREAD_KEY);
    expect(drawn).not.toMatch(SLUG);
    expect(drawn).toContain(
      'A message in #office-asks in Slack, in the thread about “Northwind’s double charge”',
    );
  });
});
