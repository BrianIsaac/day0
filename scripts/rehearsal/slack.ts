/**
 * The rehearsal's own Slack calls: verify the bot token, list what the bot
 * posted during the run, and delete those messages afterwards.
 */

const API = 'https://slack.com/api/';

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

/** A Web API client over one bot token and an injectable fetch. */
export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    method: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<SlackAnswer> {
    const url = new URL(method, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url.toString(), {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json()) as SlackAnswer;
    if (!answer.ok) throw new Error(`Slack ${method}: ${answer.error ?? `HTTP ${response.status}`}`);
    return answer;
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
    await this.call('chat.delete', {}, { channel, ts });
  }
}

/**
 * The bot's own messages at or after the run start, the only ones the run
 * may delete.
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
): SlackMessage[] {
  const start = Number.parseFloat(startTs);
  return messages.filter(
    (message: SlackMessage): boolean =>
      message.botId === botId && Number.parseFloat(message.ts) >= start,
  );
}
