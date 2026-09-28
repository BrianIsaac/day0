/**
 * Day0's own Slack Web API calls, for the scripts that set up and put back a
 * workspace (the company bed and its rehearsal): verify the bot token, read a
 * conversation, and delete the bot's own messages, each with one transient retry.
 * A failure is classed by the product's own transport helper, so a script and
 * a sync read the same answer the same way.
 */

import { retryAfterMs, transportFailureKind } from '../../src/lib/transport-error';

const API = 'https://slack.com/api/';
/** How long one Slack Web API call may take. */
export const SLACK_TIMEOUT_MS = 30_000;
/** The pause before the one retry of a Slack call that was rate limited. */
export const SLACK_RETRY_PAUSE_MS = 2_000;
/** The longest Retry-After the bed honours before giving up on a call. */
export const MAX_SLACK_RETRY_WAIT_MS = 60_000;

/** One Slack message as the bed reads it back: its timestamp, text and thread. */
export interface SlackMessage {
  ts: string;
  text: string;
  botId?: string;
  user?: string;
}

/** A Slack Web API reply's envelope: ok, and the error name when not. */
export interface SlackAnswer {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** What the retry needs from its caller: a line to say and a way to wait. */
export interface SlackRetryIo {
  say(line: string): void;
  sleep(ms: number): Promise<void>;
}

/** A Slack Web API call that failed, with the status and the error Slack named. */
export class SlackRequestError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly transient: boolean,
    readonly waitMs?: number,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SlackRequestError';
  }
}

/** The retry io for a script: says nothing and sleeps for real. */
export const DEFAULT_SLACK_RETRY_IO: SlackRetryIo = {
  say: (): void => undefined,
  sleep: async (ms: number): Promise<void> => await new Promise((done) => setTimeout(done, ms)),
};

function seconds(ms: number): number {
  return Math.ceil(ms / 1_000);
}

/**
 * The failure a rejected fetch or body read stands for.
 *
 * Our own timeout is a timeout; a caller's abort is the caller's and is
 * thrown as it came; a connection nobody answered or one cut off mid-answer
 * is a transient, as `transportFailureKind` reads the error chain. Anything
 * else, a refused certificate among them, is not Slack's and is thrown as it came.
 */
function transportFailure(error: unknown): unknown {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new SlackRequestError(
      `Slack did not answer within ${seconds(SLACK_TIMEOUT_MS)} s.`,
      'a timeout',
      true,
    );
  }
  if (error instanceof Error && error.name === 'AbortError') return error;
  const kind = transportFailureKind(error);
  if (kind === undefined) return error;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return new SlackRequestError(
    `Slack could not be reached${cause ? ` (${cause})` : ''}.`,
    kind === 'refused' ? 'a network failure' : 'a dropped connection',
    true,
  );
}

/** Run a Slack call and, if Slack rate limits it, wait what it asked and try once more. */
export async function retrySlackOnce<T>(
  what: string,
  io: SlackRetryIo,
  first: () => Promise<T>,
  again: (failure: SlackRequestError) => Promise<T> = first,
): Promise<T> {
  try {
    return await first();
  } catch (error) {
    if (!(error instanceof SlackRequestError) || !error.transient) throw error;
    const asked = error.waitMs;
    if (asked !== undefined && asked > MAX_SLACK_RETRY_WAIT_MS) {
      throw new SlackRequestError(
        `${what} failed: Slack asked to wait ${seconds(asked)} s after ${error.reason}, longer than the ${seconds(MAX_SLACK_RETRY_WAIT_MS)} s a retry waits`,
        error.reason,
        false,
        asked,
        error.status,
        error.code,
      );
    }
    io.say(
      `retrying ${what} after ${error.reason}${asked === undefined ? '' : `, in ${seconds(asked)} s as Slack asked`}`,
    );
    await io.sleep(asked ?? SLACK_RETRY_PAUSE_MS);
    try {
      return await again(error);
    } catch (second) {
      const reason =
        second instanceof SlackRequestError && second.transient
          ? second.reason
          : second instanceof Error
            ? second.message
            : String(second);
      throw new SlackRequestError(
        `${what} failed twice: ${error.reason}, then ${reason}`,
        reason,
        false,
      );
    }
  }
}

/** One Slack Web API call with the bed token, decoded and checked for ok. */
export async function requestSlack(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  params: Record<string, string> = {},
  body?: Record<string, unknown>,
  now: () => number = Date.now,
): Promise<SlackAnswer> {
  const url = new URL(method, API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url.toString(), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw transportFailure(error);
  }
  let answer: SlackAnswer | undefined;
  try {
    answer = JSON.parse(text) as SlackAnswer;
  } catch {
    answer = undefined;
  }
  const reason = `HTTP ${response.status}`;
  const code = answer?.error;
  if (response.status === 429 || response.status >= 500) {
    throw new SlackRequestError(
      `Slack ${method}: ${code ?? reason}`,
      reason,
      true,
      retryAfterMs(response.headers.get('retry-after'), now()),
      response.status,
      code,
    );
  }
  if (!response.ok) {
    throw new SlackRequestError(
      `Slack ${method}: ${code ?? reason}`,
      reason,
      false,
      undefined,
      response.status,
      code,
    );
  }
  if (!answer) {
    throw new SlackRequestError(
      `Slack ${method}: ${reason} with invalid JSON`,
      reason,
      false,
      undefined,
      response.status,
    );
  }
  if (!answer.ok) {
    const transient = code === 'ratelimited';
    throw new SlackRequestError(
      `Slack ${method}: ${code ?? reason}`,
      transient ? 'a Slack rate limit' : reason,
      transient,
      retryAfterMs(response.headers.get('retry-after'), now()),
      response.status,
      code,
    );
  }
  return answer;
}

/** A Web API client over one bot token and an injectable fetch. */
export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retry: SlackRetryIo = DEFAULT_SLACK_RETRY_IO,
    private readonly now: () => number = Date.now,
  ) {}

  private async callOnce(
    method: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<SlackAnswer> {
    return await requestSlack(this.fetchImpl, this.token, method, params, body, this.now);
  }

  private async call(
    method: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
    goneAfterRetry?: string,
  ): Promise<SlackAnswer> {
    const what = `Slack ${method}`;
    return await retrySlackOnce(
      what,
      this.retry,
      () => this.callOnce(method, params, body),
      async (failure): Promise<SlackAnswer> => {
        try {
          return await this.callOnce(method, params, body);
        } catch (error) {
          if (!(error instanceof SlackRequestError) || error.code !== goneAfterRetry) throw error;
          const reason = failure.reason.replace(/^an? /, '');
          this.retry.say(`the first ${what} landed before the ${reason}; not sent again`);
          return { ok: true };
        }
      },
    );
  }

  /** The workspace and the bot identity the token carries. */
  async authTest(): Promise<{ team: string; userId: string; botId: string }> {
    const answer = await this.call('auth.test');
    return {
      team: String(answer.team ?? ''),
      userId: String(answer.user_id ?? ''),
      botId: String(answer.bot_id ?? ''),
    };
  }

  /**
   * Messages in a conversation from a timestamp onwards, newest first.
   *
   * Args:
   *   channel: Channel or DM id.
   *   oldest: Inclusive lower bound on `ts`.
   *
   * Returns:
   *   The messages.
   */
  async history(channel: string, oldest: string): Promise<SlackMessage[]> {
    const answer = await this.call('conversations.history', {
      channel,
      oldest,
      inclusive: 'true',
      limit: '200',
    });
    const messages = (answer.messages ?? []) as Array<{
      ts: string;
      text?: string;
      bot_id?: string;
      user?: string;
    }>;
    return messages.map(
      (message): SlackMessage => ({
        ts: message.ts,
        text: message.text ?? '',
        botId: message.bot_id,
        user: message.user,
      }),
    );
  }

  /** Delete one of the bot's own messages. */
  async deleteMessage(channel: string, ts: string): Promise<void> {
    await this.call('chat.delete', {}, { channel, ts }, 'message_not_found');
  }
}
