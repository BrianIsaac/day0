/**
 * The company bed's Slack calls. The token check and deletes go through the
 * rehearsal's client; the channel listing and thread reads it has no method
 * for are the read-only calls below, over the same token and fetch.
 *
 * The bed never posts. What it deletes is only what the shared bot posted,
 * carrying the server's provenance trailer, in the bed's own conversations,
 * since the bed was first seeded.
 */

import { containsProvenanceTrailer } from '../../src/surfaces/policy';
import {
  DEFAULT_SLACK_RETRY_IO,
  requestSlack,
  retrySlackOnce,
  SlackClient,
  type SlackAnswer,
  type SlackRetryIo,
} from '../rehearsal/slack';

export { SlackClient };
export type { SlackRetryIo };

const MAX_PAGES = 20;

/**
 * What the shared bot needs: the product's reads and posts, and
 * `chat:write.customize` so each employee's messages carry its own name.
 */
export const REQUIRED_SCOPES: readonly string[] = [
  'chat:write',
  'chat:write.customize',
  'channels:read',
  'channels:history',
  'im:read',
  'im:write',
  'im:history',
  'users:read',
  'users:read.email',
];

export interface BedChannel {
  id: string;
  name: string;
  isMember: boolean;
}

export interface BedMessage {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  botId?: string;
}

/**
 * A fetch that records the token's scopes from the header Slack returns on
 * every Web API call, so the rehearsal client's `auth.test` reports them too.
 *
 * Args:
 *   fetchImpl: The fetch to wrap.
 *
 * Returns:
 *   The wrapped fetch and a reader for the last scopes seen.
 */
export function scopeRecordingFetch(fetchImpl: typeof fetch): {
  fetch: typeof fetch;
  scopes: () => string[] | undefined;
} {
  let scopes: string[] | undefined;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetchImpl(input, init);
    const header = response.headers.get('x-oauth-scopes');
    if (header !== null) {
      scopes = header
        .split(',')
        .map((scope: string): string => scope.trim())
        .filter(Boolean);
    }
    return response;
  }) as typeof fetch;
  return { fetch: wrapped, scopes: () => scopes };
}

async function slackGet(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  params: Record<string, string>,
  retry: SlackRetryIo = DEFAULT_SLACK_RETRY_IO,
  now: () => number = Date.now,
): Promise<SlackAnswer> {
  return await retrySlackOnce(`Slack ${method}`, retry, () => requestSlack(fetchImpl, token, method, params, undefined, now));
}

function nextCursor(answer: SlackAnswer): string | undefined {
  const metadata = answer.response_metadata as { next_cursor?: string } | undefined;
  return metadata?.next_cursor || undefined;
}

/**
 * Conversations the bot can see, of the given types.
 *
 * Args:
 *   fetchImpl: The fetch.
 *   token: The bot token.
 *   types: Slack conversation types, comma separated.
 *
 * Returns:
 *   Each conversation's id, name and whether the bot is a member.
 */
export async function listConversations(
  fetchImpl: typeof fetch,
  token: string,
  types: string,
  retry: SlackRetryIo = DEFAULT_SLACK_RETRY_IO,
  now: () => number = Date.now,
): Promise<BedChannel[]> {
  const channels: BedChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await slackGet(fetchImpl, token, 'conversations.list', {
      types,
      exclude_archived: 'true',
      limit: '200',
      ...(cursor ? { cursor } : {}),
    }, retry, now);
    for (const raw of (answer.channels ?? []) as Array<Record<string, unknown>>) {
      if (typeof raw.id !== 'string') continue;
      channels.push({
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : '',
        // A direct message has no membership flag; the bot is always in its own.
        isMember: raw.is_member === true || raw.is_im === true,
      });
    }
    cursor = nextCursor(answer);
    if (!cursor) return channels;
  }
  throw new Error(`Slack conversations.list did not finish within ${MAX_PAGES} pages.`);
}

function asMessage(channel: string, raw: Record<string, unknown>): BedMessage | undefined {
  if (typeof raw.ts !== 'string') return undefined;
  return {
    channel,
    ts: raw.ts,
    text: typeof raw.text === 'string' ? raw.text : '',
    user: typeof raw.user === 'string' ? raw.user : undefined,
    botId: typeof raw.bot_id === 'string' ? raw.bot_id : undefined,
  };
}

/**
 * Every message in a conversation from a timestamp on, thread replies included.
 *
 * The whole history is listed even with a bound, because a reply posted
 * after it can sit under an ask posted before it; the bound is applied to
 * each message and to each thread's latest reply.
 *
 * Args:
 *   fetchImpl: The fetch.
 *   token: The bot token.
 *   channel: The conversation id.
 *   oldest: Inclusive lower bound on `ts`, or undefined for the whole history.
 *
 * Returns:
 *   Top-level messages and the replies under them, each once.
 */
export async function conversationMessages(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  oldest?: string,
  retry: SlackRetryIo = DEFAULT_SLACK_RETRY_IO,
  now: () => number = Date.now,
): Promise<BedMessage[]> {
  const bound = oldest === undefined ? Number.NEGATIVE_INFINITY : Number.parseFloat(oldest);
  const messages: BedMessage[] = [];
  const threads: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) throw new Error(`Slack conversations.history on ${channel} did not finish.`);
    const answer = await slackGet(fetchImpl, token, 'conversations.history', {
      channel,
      limit: '200',
      ...(cursor ? { cursor } : {}),
    }, retry, now);
    for (const raw of (answer.messages ?? []) as Array<Record<string, unknown>>) {
      const message = asMessage(channel, raw);
      if (!message) continue;
      if (Number.parseFloat(message.ts) >= bound) messages.push(message);
      const latest = typeof raw.latest_reply === 'string' ? raw.latest_reply : message.ts;
      if (typeof raw.reply_count === 'number' && raw.reply_count > 0 && Number.parseFloat(latest) >= bound) {
        threads.push(message.ts);
      }
    }
    cursor = nextCursor(answer);
    if (!cursor) break;
  }
  for (const thread of threads) {
    cursor = undefined;
    for (let page = 0; ; page += 1) {
      if (page === MAX_PAGES) throw new Error(`Slack conversations.replies on ${channel} did not finish.`);
      const answer = await slackGet(fetchImpl, token, 'conversations.replies', {
        channel,
        ts: thread,
        limit: '200',
        ...(cursor ? { cursor } : {}),
      }, retry, now);
      for (const raw of (answer.messages ?? []) as Array<Record<string, unknown>>) {
        const message = asMessage(channel, raw);
        // The thread's parent comes back first in every replies page.
        if (!message || message.ts === thread || Number.parseFloat(message.ts) < bound) continue;
        messages.push(message);
      }
      cursor = nextCursor(answer);
      if (!cursor) break;
    }
  }
  return messages;
}

/**
 * The messages the bed may delete: the shared bot's own, carrying the
 * server's provenance trailer, posted at or after the bed's epoch.
 *
 * Args:
 *   messages: A conversation's messages.
 *   botId: The bot the token belongs to.
 *   epoch: The bed's first seed, as a Slack timestamp.
 *
 * Returns:
 *   The messages, in the order given.
 */
export function bedMessages(messages: readonly BedMessage[], botId: string, epoch: string): BedMessage[] {
  const start = Number.parseFloat(epoch);
  return messages.filter(
    (message: BedMessage): boolean =>
      message.botId === botId &&
      Number.parseFloat(message.ts) >= start &&
      containsProvenanceTrailer(message.text),
  );
}

/**
 * Asks a person posted that mention the bot: a new deployment's first poll
 * reads a channel's whole history, so each of these is work it would take up.
 *
 * Args:
 *   messages: A channel's messages.
 *   botUserId: The bot's user id, as a mention carries it.
 *
 * Returns:
 *   The mentions not posted by the bot itself.
 */
export function strayAsks(messages: readonly BedMessage[], botUserId: string): BedMessage[] {
  const mention = `<@${botUserId}>`;
  return messages.filter(
    (message: BedMessage): boolean =>
      message.text.includes(mention) && message.botId === undefined && message.user !== botUserId,
  );
}

/**
 * A Slack timestamp for a clock reading.
 *
 * Args:
 *   now: Milliseconds since the epoch.
 *
 * Returns:
 *   `<seconds>.000000`.
 */
export function slackTs(now: number): string {
  return `${Math.floor(now / 1_000)}.000000`;
}
