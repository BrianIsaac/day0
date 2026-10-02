/*
 * An in-memory Slack Web API for the convex tests of an employee's own app (wave 11, 11-AS), with
 * the semantics `fake-slack/server.js` gives the bed: the configuration token and its rotation
 * (S2; a token lapses twelve hours after it is issued, and a rotation spends its refresh token),
 * one app per `apps.manifest.create` with its own client and bot, a bot token's `auth.revoke`
 * taking the bot out of every channel (S1), `conversations.join` of a public channel (RM4), and an
 * app's deletion with the current configuration token (S4). It is the network seam (standard
 * 11.3): the code under test makes its real calls to it. Every token is a fake in the tree's
 * short shapes.
 */

/** The configuration token IT lands, and its refresh token. */
export const LANDED_CONFIGURATION_TOKEN = 'xoxe.xoxp-1-cfg0';
export const LANDED_REFRESH_TOKEN = 'xoxe-1-ref0';

/** Twelve hours, the configuration token's life (S2). */
const CONFIGURATION_LIFE_MS = 12 * 60 * 60 * 1000;

/** One call the code under test made, its bearer and its arguments. */
export interface SlackCall {
  readonly method: string;
  readonly bearer?: string;
  readonly form: Readonly<Record<string, string>>;
}

/** One app the double created. */
export interface DoubleApp {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly botToken: string;
  readonly botUserId: string;
  deleted: boolean;
}

/** A public channel of the double's workspace. */
const PUBLIC_CHANNELS: readonly { readonly id: string; readonly name: string }[] = [
  { id: 'C_REVOPS', name: 'revops' },
  { id: 'C_REVOPS_ASKS', name: 'revops-asks' },
];

/** The double, its fetch and what it holds. */
export interface SlackDouble {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly calls: SlackCall[];
  readonly apps: DoubleApp[];
  readonly configuration: {
    token: string;
    refreshToken: string;
    issuedAt: number;
    rotations: number;
  };
  /** Each live bot's channels, by its bot user id. */
  readonly memberships: Map<string, Set<string>>;
  readonly revokedBots: Set<string>;
  /** Called inside a rotation, before it answers: a test makes a concurrent rotation land here. */
  beforeRotationAnswers?: () => Promise<void>;
  /** The methods that answer with this error instead. */
  readonly refusals: Map<string, string>;
}

function answer(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bearerOf(init: RequestInit | undefined): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const header = headers.Authorization ?? headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

function formOf(init: RequestInit | undefined): Record<string, string> {
  const body = typeof init?.body === 'string' ? init.body : '';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const type = String(headers['Content-Type'] ?? headers['content-type'] ?? '');
  if (type.startsWith('application/json')) {
    const parsed: unknown = body ? JSON.parse(body) : {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }
  return Object.fromEntries(new URLSearchParams(body));
}

/**
 * A fresh double: IT's landed configuration pair issued at `issuedAt` (now, by default), no app.
 *
 * @param options.issuedAt - When the landed configuration token was issued.
 */
export function slackDouble(options: { readonly issuedAt?: number } = {}): SlackDouble {
  const double: SlackDouble = {
    calls: [],
    apps: [],
    configuration: {
      token: LANDED_CONFIGURATION_TOKEN,
      refreshToken: LANDED_REFRESH_TOKEN,
      issuedAt: options.issuedAt ?? Date.now(),
      rotations: 0,
    },
    memberships: new Map(),
    revokedBots: new Set(),
    refusals: new Map(),
    fetch: async (input, init) => {
      const method = new URL(String(input)).pathname.split('/').pop() ?? '';
      const bearer = bearerOf(init);
      const form = formOf(init);
      double.calls.push({ method, ...(bearer === undefined ? {} : { bearer }), form });
      const refusal = double.refusals.get(method);
      if (refusal !== undefined) return answer({ ok: false, error: refusal });
      return await respond(double, method, bearer, form);
    },
  };
  return double;
}

/** Whether the bearer is the current configuration token, still inside its twelve hours. */
function configurationAnswer(double: SlackDouble, bearer: string | undefined): string | undefined {
  if (bearer !== double.configuration.token) return 'invalid_auth';
  if (Date.now() - double.configuration.issuedAt >= CONFIGURATION_LIFE_MS) return 'token_expired';
  return undefined;
}

function liveBot(double: SlackDouble, bearer: string | undefined): DoubleApp | undefined {
  return double.apps.find(
    (app) => !app.deleted && app.botToken === bearer && !double.revokedBots.has(app.botUserId),
  );
}

function endBot(double: SlackDouble, app: DoubleApp): void {
  double.revokedBots.add(app.botUserId);
  double.memberships.delete(app.botUserId);
}

async function respond(
  double: SlackDouble,
  method: string,
  bearer: string | undefined,
  form: Readonly<Record<string, string>>,
): Promise<Response> {
  const { configuration } = double;
  switch (method) {
    case 'tooling.tokens.rotate': {
      if (form.refresh_token !== configuration.refreshToken) {
        return answer({ ok: false, error: 'invalid_refresh_token' });
      }
      configuration.rotations += 1;
      configuration.token = `xoxe.xoxp-1-cfg${configuration.rotations}`;
      configuration.refreshToken = `xoxe-1-ref${configuration.rotations}`;
      configuration.issuedAt = Date.now();
      const issued = { token: configuration.token, refresh: configuration.refreshToken };
      await double.beforeRotationAnswers?.();
      const iat = Math.floor(Date.now() / 1000);
      return answer({
        ok: true,
        token: issued.token,
        refresh_token: issued.refresh,
        iat,
        exp: iat + CONFIGURATION_LIFE_MS / 1000,
      });
    }
    case 'apps.manifest.create': {
      const refused = configurationAnswer(double, bearer);
      if (refused !== undefined) return answer({ ok: false, error: refused });
      if (!form.manifest) return answer({ ok: false, error: 'invalid_manifest' });
      const n = double.apps.length + 1;
      const app: DoubleApp = {
        appId: `A0APP${n}`,
        clientId: `1234.${n}`,
        clientSecret: `w11as-secret-${n}`,
        code: `w11as-code-${n}`,
        botToken: `xoxb-1234567890-bot${n}`,
        botUserId: `U0BOT${n}`,
        deleted: false,
      };
      double.apps.push(app);
      return answer({
        ok: true,
        app_id: app.appId,
        credentials: { client_id: app.clientId, client_secret: app.clientSecret },
      });
    }
    case 'apps.manifest.delete': {
      const refused = configurationAnswer(double, bearer);
      if (refused !== undefined) return answer({ ok: false, error: refused });
      const app = double.apps.find((candidate) => candidate.appId === form.app_id);
      if (!app || app.deleted) return answer({ ok: false, error: 'invalid_app_id' });
      app.deleted = true;
      endBot(double, app);
      return answer({ ok: true });
    }
    case 'apps.uninstall': {
      const app = liveBot(double, bearer);
      if (!app) return answer({ ok: false, error: 'invalid_auth' });
      if (form.client_id !== app.clientId || form.client_secret !== app.clientSecret) {
        return answer({ ok: false, error: 'bad_client_secret' });
      }
      endBot(double, app);
      return answer({ ok: true });
    }
    case 'oauth.v2.access': {
      const app = double.apps.find((candidate) => candidate.code === form.code);
      if (!app || app.deleted || form.client_secret !== app.clientSecret) {
        return answer({ ok: false, error: 'invalid_code' });
      }
      double.revokedBots.delete(app.botUserId);
      return answer({
        ok: true,
        access_token: app.botToken,
        bot_user_id: app.botUserId,
        team: { id: 'T0W11AS' },
      });
    }
    case 'auth.revoke': {
      const app = liveBot(double, bearer);
      if (!app) return answer({ ok: false, error: 'invalid_auth' });
      endBot(double, app);
      return answer({ ok: true, revoked: true });
    }
    default:
      break;
  }
  const bot = liveBot(double, bearer);
  if (!bot) return answer({ ok: false, error: 'invalid_auth' });
  switch (method) {
    case 'auth.test':
      return answer({ ok: true, user_id: bot.botUserId, team_id: 'T0W11AS' });
    case 'users.lookupByEmail':
      return answer({ ok: true, user: { id: 'U0MANAGER', real_name: 'Ana', deleted: false } });
    case 'conversations.open':
      return answer({ ok: true, channel: { id: 'D0MANAGER' } });
    case 'conversations.list': {
      const joined = double.memberships.get(bot.botUserId) ?? new Set<string>();
      return answer({
        ok: true,
        channels: PUBLIC_CHANNELS.map((channel) => ({
          ...channel,
          is_member: joined.has(channel.id),
        })),
        response_metadata: { next_cursor: '' },
      });
    }
    case 'conversations.join': {
      const channel = PUBLIC_CHANNELS.find((candidate) => candidate.id === form.channel);
      if (!channel) return answer({ ok: false, error: 'channel_not_found' });
      const joined = double.memberships.get(bot.botUserId) ?? new Set<string>();
      joined.add(channel.id);
      double.memberships.set(bot.botUserId, joined);
      return answer({ ok: true, channel: { ...channel, is_member: true } });
    }
    default:
      return answer({ ok: false, error: 'method_not_supported_by_double' });
  }
}

/** The double's calls of one method. */
export function callsOf(double: SlackDouble, method: string): SlackCall[] {
  return double.calls.filter((call) => call.method === method);
}
