/**
 * The rehearsal's own Slack calls: verify the bot token, list what the bot
 * posted during the run, and delete those messages afterwards.
 */

const API = 'https://slack.com/api/';
export const SLACK_TIMEOUT_MS = 30_000;
export const SLACK_RETRY_PAUSE_MS = 2_000;
export const MAX_SLACK_RETRY_WAIT_MS = 60_000;

export interface SlackMessage {
  ts: string;
  text: string;
  botId?: string;
  user?: string;
}

interface SlackAnswer {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface SlackRetryIo {
  say(line: string): void;
  sleep(ms: number): Promise<void>;
}

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

const DEFAULT_RETRY_IO: SlackRetryIo = {
  say: (): void => undefined,
  sleep: async (ms: number): Promise<void> => await new Promise((done) => setTimeout(done, ms)),
};

function seconds(ms: number): number {
  return Math.ceil(ms / 1_000);
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function transportFailure(error: unknown): unknown {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new SlackRequestError(
      `Slack did not answer within ${seconds(SLACK_TIMEOUT_MS)} s.`,
      'a timeout',
      true,
    );
  }
  return error;
}

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
    io.say(`retrying ${what} after ${error.reason}${asked === undefined ? '' : `, in ${seconds(asked)} s as Slack asked`}`);
    await io.sleep(asked ?? SLACK_RETRY_PAUSE_MS);
    try {
      return await again(error);
    } catch (second) {
      const reason = second instanceof SlackRequestError && second.transient ? second.reason : (second as Error).message;
      throw new SlackRequestError(`${what} failed twice: ${error.reason}, then ${reason}`, reason, false);
    }
  }
}

/** A Web API client over one bot token and an injectable fetch. */
export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retry: SlackRetryIo = DEFAULT_RETRY_IO,
    private readonly now: () => number = Date.now,
  ) {}

  private async callOnce(
    method: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<SlackAnswer> {
    const url = new URL(method, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
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
        retryAfterMs(response.headers.get('retry-after'), this.now()),
        response.status,
        code,
      );
    }
    if (!response.ok) {
      throw new SlackRequestError(`Slack ${method}: ${code ?? reason}`, reason, false, undefined, response.status, code);
    }
    if (!answer) {
      throw new SlackRequestError(`Slack ${method}: ${reason} with invalid JSON`, reason, false, undefined, response.status);
    }
    if (!answer.ok) {
      const transient = code === 'ratelimited';
      throw new SlackRequestError(
        `Slack ${method}: ${code ?? reason}`,
        transient ? 'a Slack rate limit' : reason,
        transient,
        retryAfterMs(response.headers.get('retry-after'), this.now()),
        response.status,
        code,
      );
    }
    return answer;
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

/** A terminal server provenance trailer attributes a write to this isolated bed. */
export function belongsToWorkItems(text: string, workItemIds: readonly string[]): boolean {
  const match = /(?:^|\n)-- [^\n]+ \(Day0\) · run ([^/\s]+)\/[^/\s]+\s*$/.exec(text);
  return match !== null && workItemIds.includes(match[1]!);
}

/**
 * Only messages with both the bot identity and this bed's work-item provenance
 * may be deleted; timestamps alone do not establish ownership.
 *
 * Args:
 *   messages: A conversation history.
 *   botId: The bot the token belongs to.
 *   startTs: The run start as a Slack timestamp.
 *
 * Returns:
 *   The messages to delete, in the order given.
 */
export function botMessagesSince(
  messages: readonly SlackMessage[],
  botId: string,
  startTs: string,
  workItemIds: readonly string[] = [],
): SlackMessage[] {
  const start = Number.parseFloat(startTs);
  return messages.filter(
    (message: SlackMessage): boolean =>
      message.botId === botId && Number.parseFloat(message.ts) >= start &&
      belongsToWorkItems(message.text, workItemIds),
  );
}
