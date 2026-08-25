import type { ActionCtx } from '../../convex/_generated/server';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { MockWriteResult } from '../../convex/mock';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import type { AdapterRun, AppliedAction, SurfaceAdapter } from './types';

export const MOCK_TOOLS = [
  'spreadsheet.appendRow',
  'slack.postMessage',
  'twitter.reply',
  'ticket.update',
] as const satisfies readonly MockAction['tool'][];

/**
 * Keep one ledger line readable in a card without losing what it identifies.
 *
 * Args:
 *   text: Provider effect text.
 *   max: Maximum output length.
 *
 * Returns:
 *   Flattened and clipped effect text.
 */
export function clipEffect(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Adapter for the existing per-agent Convex mock environment. */
class MockSurfaceAdapter implements SurfaceAdapter {
  readonly tools = MOCK_TOOLS;

  /**
   * Read the complete per-agent mock workbench.
   *
   * Args:
   *   ctx: Convex action context.
   *   agentId: Agent whose isolated environment is read.
   *
   * Returns:
   *   Hydrated documents, sheets, messages, tweets and tickets.
   */
  async read(ctx: ActionCtx, agentId: Id<'agents'>): Promise<MockSurfaceSnapshot> {
    const docs: Doc<'mockDocs'>[] = await ctx.runQuery(api.mock.listDocs, { agentId });
    const sheets: Doc<'mockSpreadsheets'>[] = await ctx.runQuery(api.mock.listSpreadsheets, {
      agentId,
    });
    const channels: Doc<'mockSlackChannels'>[] = await ctx.runQuery(api.mock.listChannels, {
      agentId,
    });
    const tweets: Doc<'mockTweets'>[] = await ctx.runQuery(api.mock.listTweets, { agentId });
    const tickets: Doc<'mockTickets'>[] = await ctx.runQuery(api.mock.listTickets, { agentId });

    const spreadsheetsHydrated = await Promise.all(
      sheets.map(async (s) => {
        const detail = await ctx.runQuery(api.mock.getSpreadsheet, { agentId, slug: s.slug });
        const rows = (detail?.rows ?? []) as Doc<'mockSpreadsheetRows'>[];
        return {
          slug: s.slug,
          title: s.title,
          tabs: s.tabs,
          rows: rows.map((r) => ({
            tabName: r.tabName,
            cells: r.cells as Record<string, string>,
          })),
        };
      }),
    );

    const channelsHydrated = await Promise.all(
      channels.map(async (c) => {
        const messages = (await ctx.runQuery(api.mock.listMessages, {
          agentId,
          channelSlug: c.slug,
        })) as Doc<'mockSlackMessages'>[];
        return {
          slug: c.slug,
          displayName: c.displayName,
          kind: c.kind,
          recentMessages: messages.slice(-12).map((m) => ({
            sender: m.sender,
            body: m.body,
            threadKey: m.threadKey,
          })),
        };
      }),
    );

    return {
      howToGuides: docs
        .filter((d) => d.category === 'how-to-guide')
        .map((d) => ({ slug: d.slug, title: d.title, body: d.body })),
      teamDocs: docs
        .filter((d) => d.category === 'team-doc')
        .map((d) => ({ slug: d.slug, title: d.title, body: d.body })),
      spreadsheets: spreadsheetsHydrated,
      slackChannels: channelsHydrated,
      tweets: tweets.map((t) => ({
        slug: t.slug,
        author: t.author,
        handle: t.handle,
        body: t.body,
      })),
      tickets: tickets.map((t) => ({
        slug: t.slug,
        title: t.title,
        status: t.status,
        body: t.body,
      })),
    };
  }

  /**
   * Apply one legacy mock action without changing its existing semantics.
   *
   * Args:
   *   ctx: Convex action context.
   *   run: Work execution identity and agent scope.
   *   action: Typed mock action emitted by the skill.
   *   index: Zero-based action position in the run.
   *   idempotencyKey: Stable run and action key for the ledger.
   *
   * Returns:
   *   An evidence row derived from the mutation result.
   */
  async apply(
    ctx: ActionCtx,
    run: AdapterRun,
    action: MockAction,
    index: number,
    idempotencyKey: string,
  ): Promise<AppliedAction> {
    void index;
    const { agentId } = run;
    const args = action.args ?? {};
    try {
      let result: MockWriteResult;
      let effect = '';
      switch (action.tool) {
        case 'spreadsheet.appendRow': {
          if (!args.sheetSlug || !args.tabName || !args.cells) {
            return {
              tool: action.tool,
              ok: false,
              reason: 'missing sheetSlug/tabName/cells',
              idempotencyKey,
            };
          }
          const cellsObj: Record<string, string> = {};
          for (const c of args.cells) cellsObj[c.header] = c.value;
          result = await ctx.runMutation(internal.mock.appendSpreadsheetRow, {
            agentId,
            sheetSlug: args.sheetSlug,
            tabName: args.tabName,
            cells: cellsObj,
            addedBy: 'Day0 (agent)',
          });
          effect = clipEffect(
            `1 row appended to ${args.sheetSlug} · ${args.tabName} — ` +
              args.cells.map((c) => `${c.header}=${c.value || '(blank)'}`).join(', '),
            180,
          );
          break;
        }
        case 'slack.postMessage': {
          if (!args.channelSlug || !args.body) {
            return {
              tool: action.tool,
              ok: false,
              reason: 'missing channelSlug/body',
              idempotencyKey,
            };
          }
          result = await ctx.runMutation(internal.mock.postSlackMessage, {
            agentId,
            channelSlug: args.channelSlug,
            threadKey: args.threadKey,
            sender: 'Day0',
            senderKind: args.channelSlug.startsWith('dm-') ? 'agent-posted' : 'agent-draft',
            body: args.body,
          });
          effect = clipEffect(
            `1 message posted to ${args.channelSlug}` +
              `${args.threadKey ? ` · thread ${args.threadKey}` : ''} — “${args.body}”`,
            180,
          );
          // A coworker only replies to a message that actually landed.
          if (result.changed) {
            await ctx.scheduler.runAfter(
              3500 + Math.floor(Math.random() * 2500),
              internal.coworker.replyToAgentMessage,
              {
                agentId,
                channelSlug: args.channelSlug,
                threadKey: args.threadKey,
                originalBody: args.body,
              },
            );
          }
          break;
        }
        case 'twitter.reply': {
          if (!args.tweetSlug || !args.body) {
            return {
              tool: action.tool,
              ok: false,
              reason: 'missing tweetSlug/body',
              idempotencyKey,
            };
          }
          result = await ctx.runMutation(internal.mock.postTweetReply, {
            agentId,
            tweetSlug: args.tweetSlug,
            author: 'Day0',
            handle: '@day0_agent',
            body: args.body,
            isAgentDraft: true,
          });
          effect = clipEffect(`1 reply drafted on ${args.tweetSlug} — “${args.body}”`, 180);
          break;
        }
        case 'ticket.update': {
          if (!args.slug) {
            return { tool: action.tool, ok: false, reason: 'missing slug', idempotencyKey };
          }
          result = await ctx.runMutation(internal.mock.updateTicket, {
            agentId,
            slug: args.slug,
            status: args.status,
            comment: args.comment,
            commentAuthor: 'Day0',
          });
          effect = clipEffect(
            [
              `ticket ${args.slug}`,
              args.status ? `set to ${args.status}` : null,
              args.comment ? `1 comment — “${args.comment}”` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            180,
          );
          break;
        }
      }
      return result.changed
        ? { tool: action.tool, ok: true, effect, idempotencyKey }
        : {
            tool: action.tool,
            ok: false,
            reason: result.reason ?? 'the work environment did not change',
            idempotencyKey,
          };
    } catch (error) {
      return {
        tool: action.tool,
        ok: false,
        reason: (error as Error).message,
        idempotencyKey,
      };
    }
  }
}

export const mockAdapter: SurfaceAdapter = new MockSurfaceAdapter();
