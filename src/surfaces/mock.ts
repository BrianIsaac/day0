import type { ActionCtx } from '../../convex/_generated/server';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
  MOCK_ACTION_TOOLS,
  type MockAction,
  type MockSurfaceSnapshot,
  type MockWriteResult,
} from '../work/types';
import type { AdapterRun, AppliedAction, SurfaceAdapter } from './types';
import { errorMessage } from '../lib/errors';

/**
 * How much of a read's provider result the ledger keeps. A read exists for the
 * closing phase to author from, so its result must survive the ledger whole
 * enough to be quoted: a ticket read cut before its state field, or a comment
 * list cut after its first entry, leaves that phase nothing to work with.
 * Writes keep the short effect line; their result is the provider id.
 */
export const READ_EFFECT_LENGTH = 4_000;

/** Keep one ledger line readable in a card without losing what it identifies: flattened and clipped to `max`. */
export function clipEffect(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Adapter for the existing per-agent Convex mock environment. */
class MockSurfaceAdapter implements SurfaceAdapter {
  readonly tools = MOCK_ACTION_TOOLS;

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
    return await ctx.runQuery(internal.mock.snapshotInternal, { agentId });
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
            `1 row appended to ${args.sheetSlug} · ${args.tabName} - ` +
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
              `${args.threadKey ? ` · thread ${args.threadKey}` : ''} - “${args.body}”`,
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
          effect = clipEffect(`1 reply drafted on ${args.tweetSlug} - “${args.body}”`, 180);
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
              args.comment ? `1 comment - “${args.comment}”` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            180,
          );
          break;
        }
        case 'mcp.call':
        case 'http.request':
          // The registry routes surface tools to their own adapters; one
          // reaching the mock adapter is a routing defect, not a work outcome.
          return { tool: action.tool, ok: false, reason: 'not a mock tool', idempotencyKey };
        default: {
          const unhandled: never = action.tool;
          throw new Error(`unhandled mock tool ${String(unhandled)}`);
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
        reason: errorMessage(error),
        idempotencyKey,
      };
    }
  }
}

export const mockAdapter: SurfaceAdapter = new MockSurfaceAdapter();
