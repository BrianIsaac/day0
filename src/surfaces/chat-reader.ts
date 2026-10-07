import { TransientProviderError } from '../lib/transport-error';
import type { MockAction } from '../work/types';
import { isSlackApiEndpoint, SLACK_API_ENDPOINT } from './slack-endpoint';
import type { SurfaceRecord } from './types';
import { channelAllowlist, mayReadChannel } from './slack-own-channel';

/**
 * The chat reader over the ladder (A6): what any chat rung must answer for
 * intake and the manager channel, whichever rung reaches the chat system.
 *
 * A6 settled that chat systems are named in the documentation and reached
 * through the existing rungs, with no bespoke adapter per product. Intake
 * and the decision sweep need the same four things from every one of them:
 * the documented channels, what was said in one since a moment, the replies
 * under one message, and the identity the rung posts as, so its own posts
 * are never read as asks. Posting is a write, so a reader never sends one:
 * it says which surface action posts, and the gate applies that action like
 * any other.
 *
 * Slack's documented Web API is the one rung implemented here. Another rung
 * or another chat system answers `chatReaderFor` with the reason it has no
 * reader yet, which is a limitation of this Day0, not of the system.
 */

/** A chat channel as its provider names it. */
export interface ChatChannel {
  readonly id: string;
  /** The name without its `#`. */
  readonly name: string;
}

/** One message as a chat rung reads it. */
export interface ChatMessage {
  /** The provider's timestamp, which is also the message's identity in its channel. */
  readonly ts: string;
  readonly text: string;
  /** The person or bot user who wrote it, when the provider says. */
  readonly user?: string;
  /** The posting app's bot id; the only author mark on a post sent under a customised name. */
  readonly botId?: string;
  readonly appId?: string;
  /** The parent message when this one sits in a thread. */
  readonly threadTs?: string;
}

/** Who the connected rung is on the chat system: every post it makes carries one of these. */
export interface ChatIdentity {
  readonly userId: string;
  readonly botId?: string;
  readonly workspaceId?: string;
}

/** A message the rung is asked to post, at the top of a channel or in a thread. */
export interface ChatPost {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
}

/**
 * What a chat rung must answer. Every read is bounded and paginated to the
 * end or refused; a rate limit or a server error is a
 * `TransientProviderError`, which the caller's backoff waits out (Q13), and
 * anything else is an `Error` another read would repeat.
 */
export interface ChatReader {
  /**
   * Resolve documented channel names to the provider's channels, in the
   * order given.
   *
   * @throws Error when a documented channel is not visible to the rung.
   */
  listChannels(names: readonly string[]): Promise<ChatChannel[]>;
  /** The messages in a channel, newest first as the provider lists them, from `since` (epoch ms) on. */
  readSince(channelId: string, since?: number): Promise<ChatMessage[]>;
  /** The replies under one message, the message itself included, from `since` (epoch ms) on. */
  readThread(channelId: string, threadTs: string, since?: number): Promise<ChatMessage[]>;
  /** Who the rung posts as, as the provider reports it now. */
  identity(): Promise<ChatIdentity>;
  /**
   * The name the chat system shows for one of its members, or undefined where the rung may not
   * ask (its allowlist names no such read) or the system gives none (an unknown member, a scope
   * the token lacks).
   */
  memberName(userId: string): Promise<string | undefined>;
  /** The surface action that posts one message; the gate applies it, the reader never sends it. */
  postAction(post: ChatPost): MockAction;
}

/**
 * A read the chat system refused with a code of its own (`not_in_channel`,
 * `thread_not_found`), which reading again would repeat. The code is kept so a
 * caller decides by it, not by the message.
 */
export class ChatReadRefused extends Error {
  readonly code: string;

  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'ChatReadRefused';
    this.code = code;
  }
}

/** The fetch a reader goes through; the caller's backoff and timeout wrap it. */
export type ChatFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** What building a reader for one surface needs. */
export interface ChatReaderDependencies {
  /** The surface's decrypted credential; it goes only in the `Authorization` header. */
  readonly credential: string;
  readonly fetch: ChatFetch;
  /** Slack's Web API base; production Slack unless a local proof overrides it. */
  readonly slackApiBase?: URL;
}

/** A reader, or why this surface's rung has none. */
export type ChatReaderResult =
  | { readonly ok: true; readonly reader: ChatReader }
  | { readonly ok: false; readonly reason: string };

/** How many `conversations.list` pages a channel lookup reads before it gives up. */
export const MAX_CHANNEL_PAGES = 50;

/** How many history or replies pages one read takes before it gives up. */
export const MAX_HISTORY_PAGES = 5;

/** The Slack Web API read methods the reader calls, each needing the surface's allowlist. */
type SlackReadMethod =
  | 'auth.test'
  | 'conversations.list'
  | 'conversations.history'
  | 'conversations.replies'
  | 'users.info';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty pagination cursor from a Slack response, or undefined. */
function slackCursor(payload: Record<string, unknown>): string | undefined {
  const cursor = asRecord(payload.response_metadata)?.next_cursor;
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined;
}

/** One message row from a Slack history or replies page, or undefined for a row without text. */
function slackMessage(item: unknown): ChatMessage | undefined {
  const row = asRecord(item);
  if (typeof row?.ts !== 'string' || typeof row.text !== 'string') return undefined;
  const marks: Array<[keyof ChatMessage, string]> = [
    ['user', 'user'],
    ['botId', 'bot_id'],
    ['appId', 'app_id'],
    ['threadTs', 'thread_ts'],
  ];
  return {
    ts: row.ts,
    text: row.text,
    ...Object.fromEntries(
      marks.flatMap(([field, key]) => (typeof row[key] === 'string' ? [[field, row[key]]] : [])),
    ),
  };
}

/**
 * The name a Slack `users.info` answer gives a member, as Slack itself shows it: the display name,
 * else the full name, else the handle; undefined when it gives none.
 */
function slackMemberName(user: unknown): string | undefined {
  const row = asRecord(user);
  const profile = asRecord(row?.profile);
  const names = [profile?.display_name, profile?.real_name, row?.real_name, row?.name];
  const found = names.find(
    (name): name is string => typeof name === 'string' && name.trim() !== '',
  );
  // One short line: the name sits in the card's ask line and in the prompts' "From:" lines.
  return found?.replace(/\s+/g, ' ').trim().slice(0, MEMBER_NAME_MAX).trimEnd();
}

/** The longest member name the reader hands on. */
const MEMBER_NAME_MAX = 80;

/**
 * The reader for a Slack workspace reached over its documented Web API.
 *
 * Each read method is called only when the surface's probed allowlist admits
 * it (on an app Day0 created, also Day0's own `auth.test` and the manager's DM),
 * with the credential as a bearer token and no redirect followed.
 *
 * @param surface - The connected Slack surface.
 * @param dependencies - The credential, the fetch and the API base.
 */
export function slackChatReader(
  surface: Pick<SurfaceRecord, 'slug' | 'toolAllowlist' | 'ownSlackApp' | 'managerDmChannelId'>,
  dependencies: ChatReaderDependencies,
): ChatReader {
  const base = dependencies.slackApiBase ?? new URL(SLACK_API_ENDPOINT);

  const get = async (
    method: SlackReadMethod,
    query: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    // Who the bot is is Day0's own question, a channel method on an app Day0 created (13-FS's
    // design 1 (b)), and so is the manager's DM on such an app (W13-R1); every other read is the
    // work's, as the page names it.
    const allowed =
      method === 'auth.test'
        ? channelAllowlist(surface).includes(method)
        : mayReadChannel(surface, method, query.channel);
    if (!allowed) {
      throw new Error(`Connected Slack surface does not allow ${method}.`);
    }
    const url = new URL(method, base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await dependencies.fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${dependencies.credential}` },
    });
    // A gateway answering for Slack sends HTML; the status is what the reason needs.
    const payload = asRecord(await response.json().catch((): undefined => undefined)) ?? {};
    if (response.ok && payload.ok === true) return payload;
    const error =
      typeof payload.error === 'string' ? payload.error : `Slack returned HTTP ${response.status}.`;
    if (response.status === 429 || error === 'ratelimited' || response.status >= 500) {
      throw new TransientProviderError(`Slack ${method} was not answered now (${error}).`, {
        status: response.status,
      });
    }
    throw new ChatReadRefused(method, error);
  };

  const readPages = async (
    method: 'conversations.history' | 'conversations.replies',
    query: Record<string, string>,
  ): Promise<ChatMessage[]> => {
    const messages: ChatMessage[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const payload = await get(method, {
        ...query,
        inclusive: 'true',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      for (const item of Array.isArray(payload.messages) ? payload.messages : []) {
        const message = slackMessage(item);
        if (message) messages.push(message);
      }
      const next = slackCursor(payload);
      if (!next) return messages;
      if (seen.has(next)) {
        throw new Error(`Slack ${method} repeated a cursor before pagination completed.`);
      }
      seen.add(next);
      cursor = next;
    }
    throw new Error(`Slack ${method} pagination did not complete within the page limit.`);
  };

  const oldest = (since: number | undefined): Record<string, string> =>
    since === undefined ? {} : { oldest: String(since / 1_000) };

  return {
    listChannels: async (names: readonly string[]): Promise<ChatChannel[]> => {
      const wanted = new Set(names.map((name: string): string => name.toLowerCase()));
      const found = new Map<string, ChatChannel>();
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CHANNEL_PAGES && found.size < wanted.size; page += 1) {
        const payload = await get('conversations.list', {
          exclude_archived: 'true',
          limit: '200',
          types: 'public_channel',
          ...(cursor ? { cursor } : {}),
        });
        for (const item of Array.isArray(payload.channels) ? payload.channels : []) {
          const channel = asRecord(item);
          if (typeof channel?.id !== 'string' || typeof channel.name !== 'string') continue;
          const name = channel.name.toLowerCase();
          if (wanted.has(name)) found.set(name, { id: channel.id, name });
        }
        if (found.size === wanted.size) break;
        cursor = slackCursor(payload);
        if (!cursor) break;
        if (seen.has(cursor)) {
          throw new Error(
            'Slack conversations.list repeated a cursor before the channel list ended.',
          );
        }
        if (page === MAX_CHANNEL_PAGES - 1) {
          throw new Error(
            `Slack conversations.list did not end within ${MAX_CHANNEL_PAGES} pages of public channels.`,
          );
        }
        seen.add(cursor);
      }
      const missing = [...wanted].filter((name: string): boolean => !found.has(name));
      if (missing.length > 0) {
        throw new Error(
          `Slack channels are not visible: ${missing.map((name: string): string => `#${name}`).join(', ')}.`,
        );
      }
      return names.map((name: string): ChatChannel => found.get(name.toLowerCase())!);
    },
    readSince: async (channelId: string, since?: number): Promise<ChatMessage[]> =>
      await readPages('conversations.history', { channel: channelId, ...oldest(since) }),
    readThread: async (channelId: string, threadTs: string, since?: number) =>
      await readPages('conversations.replies', {
        channel: channelId,
        ts: threadTs,
        ...oldest(since),
      }),
    identity: async (): Promise<ChatIdentity> => {
      const auth = await get('auth.test', {});
      if (typeof auth.user_id !== 'string' || !auth.user_id) {
        throw new Error('Slack auth.test returned no bot identity.');
      }
      return {
        userId: auth.user_id,
        ...(typeof auth.bot_id === 'string' && auth.bot_id ? { botId: auth.bot_id } : {}),
        ...(typeof auth.team_id === 'string' && auth.team_id ? { workspaceId: auth.team_id } : {}),
      };
    },
    memberName: async (userId: string): Promise<string | undefined> => {
      // Optional, as `chat.update` is: a policy that does not name it leaves the asker unnamed.
      if (!surface.toolAllowlist?.includes('users.info')) return undefined;
      try {
        return slackMemberName((await get('users.info', { user: userId })).user);
      } catch (error) {
        // A member Slack does not know is an answer: no name to give. Any other refusal
        // (`missing_scope`, `invalid_auth`) is a misconfiguration, and a rate limit or a server
        // error is not an answer at all: the caller notes either.
        if (error instanceof ChatReadRefused && error.code === 'user_not_found') return undefined;
        throw error;
      }
    },
    postAction: (post: ChatPost): MockAction => ({
      tool: 'http.request',
      args: {
        surface: surface.slug,
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({
          Authorization: 'Bearer {{secret}}',
          'Content-Type': 'application/json; charset=utf-8',
        }),
        body: JSON.stringify({
          channel: post.channel,
          text: post.text,
          ...(post.threadTs ? { thread_ts: post.threadTs } : {}),
        }),
      },
    }),
  };
}

/**
 * The chat reader for one connected chat surface, chosen by the rung it was
 * approved on, or why that rung has none yet.
 *
 * @param surface - A connected surface whose class is `chat`.
 * @param dependencies - The credential, the fetch and the API base.
 */
export function chatReaderFor(
  surface: Pick<
    SurfaceRecord,
    | 'slug'
    | 'displayName'
    | 'path'
    | 'endpoint'
    | 'toolAllowlist'
    | 'ownSlackApp'
    | 'managerDmChannelId'
  >,
  dependencies: ChatReaderDependencies,
): ChatReaderResult {
  switch (surface.path) {
    case 'documented-api':
      return isSlackApiEndpoint(surface.endpoint)
        ? { ok: true, reader: slackChatReader(surface, dependencies) }
        : {
            ok: false,
            reason: `Day0 reads chat over a documented API only through Slack's Web API, so it has no reader for ${surface.displayName} at ${surface.endpoint ?? 'an undocumented address'}.`,
          };
    case 'mcp':
    case 'browser-driven':
      return {
        ok: false,
        reason: `Day0 has no chat reader on the ${surface.path} rung yet, so ${surface.displayName}'s channels are not read; its manager decisions are taken on the dashboard.`,
      };
    case 'escalate':
    case undefined:
      return {
        ok: false,
        reason: `${surface.displayName} is not reached by any rung, so it has no chat reader.`,
      };
  }
}
