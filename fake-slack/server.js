import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_SLACK_PORT || 8090);
const calls = new Map();
const requestLog = [];
// chat.postMessage counts per channel, never the text: a handover between two
// managers shows as one post in each of their DMs.
const postsByChannel = new Map();

// IT's app configuration token and its refresh token (S2). A rotation spends the
// refresh token it is given and issues a new pair; only the newest token is
// accepted. A reset keeps the pair: it is a credential Day0 holds, not evidence.
const TWELVE_HOURS_S = 12 * 60 * 60;
const configuration = {
  token: 'xoxe-day0-fake-configuration-token',
  refreshToken: 'xoxe-day0-fake-configuration-refresh',
  rotations: 0,
};

// As real Slack answered the real-vendor walk (3 October 2026, R41V-10): a rotation revokes the
// configuration token it replaces, auth.revoke of a configuration token ends that token alone
// (its refresh token still rotates), and a token already revoked answers token_revoked.
const revokedConfigurationTokens = new Set();

/**
 * One employee's own app, as apps.manifest.create made it. The first is the app
 * the fake has always answered for: its bot token works before any install, as
 * the probes and the revocation rung expect. Every later app's bot exists only
 * once its install has been exchanged.
 */
function appNumbered(number) {
  const suffix = number === 1 ? '' : `-${number}`;
  return {
    appId: number === 1 ? 'A_DAY0_FAKE' : `A_DAY0_FAKE_${number}`,
    clientId: number === 1 ? '111.day0' : `111.day0.${number}`,
    clientSecret: `day0-fake-client-secret${suffix}`,
    code: `day0-fake-authorisation-code${suffix}`,
    botToken: `xoxb-day0-fake-dedicated-token${suffix}`,
    botUserId: number === 1 ? 'U_DAY0_BOT' : `U_DAY0_BOT_${number}`,
    created: false,
    deleted: false,
    installed: number === 1,
    // The app-level token a person generates in the app's settings (K2), once they have.
    appLevelToken: undefined,
    // The manifest it was created from, or last updated to (W12V-7). The first app answered
    // before any manifest, and takes messages as it always has.
    manifest: undefined,
    takesMessages: number === 1,
  };
}

/**
 * Whether a manifest lets a person message the app: its App Home messages tab on and not
 * read-only, as the walk on real Slack found (W12V-7).
 */
function manifestTakesMessages(manifest) {
  const home = manifest && manifest.features && manifest.features.app_home;
  return Boolean(
    home && home.messages_tab_enabled === true && home.messages_tab_read_only_enabled === false,
  );
}

/** Slack's markup a message's text carries: what Slack would read as a mention or a link. */
const MARKUP = /<(?:!(?:here|channel|everyone)|@[UW][A-Z0-9]+|#C[A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The same markup escaped as Slack asks (`&lt;!here&gt;`), which Slack shows as text. */
const ESCAPED_MARKUP =
  /&lt;(?:!(?:here|channel|everyone)|@[UW][A-Z0-9]+|#C[A-Z0-9]+)(?:\|(?:(?!&gt;).)*)?&gt;/g;

/**
 * What the fake keeps of a message's text: the markup Slack would read in it as a mention or a
 * link, and the markup it carries escaped, which Slack shows as text (W12V-7's pre-tag). Never
 * the body.
 */
function markupOf(text) {
  const written = typeof text === 'string' ? text : '';
  return {
    mentions: written.match(MARKUP) || [],
    escapedMarkup: written.match(ESCAPED_MARKUP) || [],
  };
}

// Revocation at the vendor (11-AR, for 11-AS): the bot tokens auth.revoke,
// apps.uninstall or apps.manifest.delete ended; and each bot's channels (S1: a
// revoked bot token leaves every channel it was in).
let apps = [appNumbered(1)];
const revokedTokens = new Set();
const memberships = new Map();

function resetApps() {
  apps = [appNumbered(1)];
  revokedTokens.clear();
  memberships.clear();
  messages.clear();
  managerMessages.length = 0;
  for (const connection of sockets) connection.socket.destroy();
  sockets.clear();
  tickets.clear();
  presses.length = 0;
}

// Day0's posted messages, by channel and ts, with the app whose bot posted them: what
// chat.update edits and a press is made on (wave 12, 12-M), with the block types and each
// button's action id, block id and value (a decision code). Never a body: of the text, only the
// markup Slack would read in it as a mention or a link and the markup it carries escaped, so a
// bed can read back that a quoted `<!here>` went out as text (W12V-7's pre-tag).
const messages = new Map();

// What the manager typed in a DM with an app (W12V-7): the decision poll reads it back through
// conversations.history, from the app the message was sent to.
const managerMessages = [];

/** What the fake keeps of a message's blocks: their types and their buttons. */
function shapeOf(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  return {
    blockTypes: list.map((block) => String(block && block.type)),
    buttons: list
      .filter((block) => block && block.type === 'actions' && Array.isArray(block.elements))
      .flatMap((block) =>
        block.elements
          .filter((element) => element && element.type === 'button')
          .map((element) => ({
            actionId: String(element.action_id),
            blockId: String(block.block_id),
            value: String(element.value),
          })),
      ),
  };
}
const messageKey = (channel, ts) => `${channel}:${ts}`;

// Socket Mode (K1): single-use tickets apps.connections.open hands out, the open connections,
// and every press with whether its envelope was acknowledged.
const tickets = new Map();
const sockets = new Set();
const presses = [];
// Slack allows an app ten open connections at once (K1).
const MAX_CONNECTIONS_PER_APP = 10;
// How long a press waits for its envelope's acknowledgement.
const ACK_WAIT_MS = 3000;
// How often each connection is pinged; one that answered nothing since the last ping is dropped,
// as a connection whose client died without closing it (a killed container) would be.
const PING_MS = Number(process.env.FAKE_SLACK_PING_MS || 10000);

function appByClientId(clientId) {
  return apps.find((app) => app.clientId === clientId);
}

/** The app whose bot token the request bears, while that token is live. */
function botOf(request) {
  const bearer = String(request.headers.authorization || '');
  return apps.find(
    (app) =>
      !app.deleted &&
      app.installed &&
      bearer === `Bearer ${app.botToken}` &&
      !revokedTokens.has(app.botToken),
  );
}

/** End a bot token: the bot is deactivated and leaves every channel (S1). */
function revokeBot(app) {
  revokedTokens.add(app.botToken);
  memberships.delete(app.botUserId);
}

// The people besides the one manager, by address (FAKE_SLACK_PEOPLE,
// comma-separated): each listed address is a Slack user of its own with a DM
// of its own, so a lookup answers per address. Every other address is still
// the one manager, as the fake has always answered. Wave 11 extends this.
const people = new Map(
  (process.env.FAKE_SLACK_PEOPLE || '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter((address) => address !== '')
    .map((address, index) => [
      address,
      {
        id: `U_DAY0_PERSON_${index + 1}`,
        dm: `D_DAY0_PERSON_${index + 1}`,
        name: address.split('@')[0],
      },
    ]),
);

function count(method) {
  calls.set(method, (calls.get(method) || 0) + 1);
  requestLog.push({ sequence: requestLog.length + 1, method, at: Date.now() });
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function bodyOf(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

// Slack's read methods take their arguments from the query string or a form
// body and do not read a JSON one: a JSON body leaves them with no arguments.
function readArguments(url, request, body) {
  const merged = new URLSearchParams(url.search);
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [name, value] of new URLSearchParams(body)) merged.set(name, value);
  }
  return merged;
}

// The workspace's public channels, which a bot may list and join.
const PUBLIC_CHANNELS = [
  { id: 'C_REVOPS', name: 'revops' },
  { id: 'C_REVOPS_ASKS', name: 'revops-asks' },
];

const CHANNELS = [
  'D_DAY0_MANAGER',
  'C_REVOPS',
  'C_REVOPS_ASKS',
  ...[...people.values()].map((person) => person.dm),
];

// A JSON body's fields, for the write methods that take one; nothing for any other body.
function jsonArguments(request, body) {
  if (
    !String(request.headers['content-type'] || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    return {};
  }
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function bearerOf(request) {
  return String(request.headers.authorization || '').replace(/^Bearer /, '');
}

/** Why the request's bearer is not the live configuration token, or nothing when it is. */
function configurationRefusal(request) {
  const bearer = bearerOf(request);
  if (revokedConfigurationTokens.has(bearer)) return 'token_revoked';
  return bearer === configuration.token ? undefined : 'invalid_auth';
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'fake-slack'}`);
  if (url.pathname === '/healthz') return json(response, 200, { ok: true });
  if (url.pathname === '/proof') {
    return json(response, 200, {
      ok: true,
      calls: Object.fromEntries(calls),
      requestLog,
      postsByChannel: Object.fromEntries(postsByChannel),
      apps: apps.filter((app) => app.created && !app.deleted).map((app) => app.appId),
      revokedTokens: revokedTokens.size,
      messages: [...messages.values()],
      socketConnections: Object.fromEntries(
        apps
          .filter((app) => app.appLevelToken)
          .map((app) => [app.appId, [...sockets].filter((s) => s.appId === app.appId).length]),
      ),
      presses,
      configurationRotations: configuration.rotations,
      configurationRevoked: revokedConfigurationTokens.size,
      // Channel ids each live app's bot is in, by app id.
      memberships: Object.fromEntries(
        apps
          .filter((app) => app.created && !app.deleted)
          .map((app) => [app.appId, [...(memberships.get(app.botUserId) || [])]]),
      ),
    });
  }
  if (url.pathname === '/proof/app-level-token' && request.method === 'POST') {
    // The person's click under Basic Information, App-Level Tokens (K2).
    const { appId } = jsonArguments(request, await bodyOf(request));
    const app = apps.find((candidate) => candidate.appId === appId && !candidate.deleted);
    if (!app) return json(response, 404, { ok: false, error: 'invalid_app_id' });
    const suffix = app.appId === 'A_DAY0_FAKE' ? '' : `-${app.appId.split('_').pop()}`;
    app.appLevelToken = `xapp-day0-fake-app-level-token${suffix}`;
    return json(response, 200, { ok: true, token: app.appLevelToken });
  }
  if (url.pathname === '/proof/manager-message' && request.method === 'POST') {
    // The manager types a reply in their DM with an app (W12V-7). Slack offers no composer under
    // an app whose messages tab is off or read-only, and says so in these words.
    const { appId, text, threadTs } = jsonArguments(request, await bodyOf(request));
    const app = apps.find((candidate) => candidate.appId === appId && !candidate.deleted);
    if (!app) return json(response, 404, { ok: false, error: 'invalid_app_id' });
    if (!app.takesMessages) {
      return json(response, 200, {
        ok: false,
        error: 'messages_tab_off',
        shown: 'Sending messages to this app has been turned off.',
      });
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return json(response, 400, { ok: false, error: 'no_text' });
    }
    // Stamped now, as Slack stamps it: Day0 reads no reply older than its employee.
    const ts = `${Math.floor(Date.now() / 1000)}.${String(managerMessages.length + 1).padStart(6, '0')}`;
    managerMessages.push({
      appId: app.appId,
      channel: 'D_DAY0_MANAGER',
      user: 'U_DAY0_MANAGER',
      text,
      ts,
      ...(typeof threadTs === 'string' ? { threadTs } : {}),
    });
    return json(response, 200, { ok: true, channel: 'D_DAY0_MANAGER', ts });
  }
  if (url.pathname === '/proof/press' && request.method === 'POST') {
    return json(response, 200, await press(jsonArguments(request, await bodyOf(request))));
  }
  if (url.pathname === '/proof/disconnect' && request.method === 'POST') {
    // Slack asking every connection of an app to refresh, or one going away (K1).
    const { appId, reason } = jsonArguments(request, await bodyOf(request));
    let told = 0;
    for (const connection of sockets) {
      if (connection.appId !== appId) continue;
      sendFrame(connection.socket, JSON.stringify({ type: 'disconnect', reason, debug_info: {} }));
      told += 1;
    }
    return json(response, 200, { ok: true, told });
  }
  if (url.pathname === '/reset' && request.method === 'POST') {
    calls.clear();
    requestLog.length = 0;
    postsByChannel.clear();
    resetApps();
    return json(response, 200, { ok: true });
  }
  if (url.pathname === '/oauth/v2/authorize' && request.method === 'GET') {
    count('oauth.v2.authorize');
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    if (!redirect || !state) return json(response, 400, { ok: false, error: 'bad_request' });
    // The app the link installs, by its client id; the first app when none is named.
    const app = appByClientId(url.searchParams.get('client_id') || '111.day0');
    if (!app || app.deleted) return json(response, 400, { ok: false, error: 'invalid_client_id' });
    const destination = new URL(redirect);
    destination.searchParams.set('code', app.code);
    destination.searchParams.set('state', state);
    response.writeHead(302, { location: destination.toString() });
    return response.end();
  }
  if (!url.pathname.startsWith('/api/')) {
    return json(response, 404, { ok: false, error: 'method_not_found' });
  }

  const method = url.pathname.slice('/api/'.length);
  count(method);
  const body = await bodyOf(request);

  if (method === 'tooling.tokens.rotate') {
    // S2: exchanges the refresh token for a new configuration token and a new
    // refresh token; the one exchanged is spent.
    const given = readArguments(url, request, body).get('refresh_token');
    if (!given || given !== configuration.refreshToken) {
      return json(response, 200, { ok: false, error: 'invalid_refresh_token' });
    }
    configuration.rotations += 1;
    revokedConfigurationTokens.add(configuration.token);
    configuration.token = `xoxe-day0-fake-configuration-token-${configuration.rotations}`;
    configuration.refreshToken = `xoxe-day0-fake-configuration-refresh-${configuration.rotations}`;
    const iat = Math.floor(Date.now() / 1000);
    return json(response, 200, {
      ok: true,
      token: configuration.token,
      refresh_token: configuration.refreshToken,
      team_id: 'T_DAY0',
      user_id: 'U_DAY0_SERVICE',
      iat,
      exp: iat + TWELVE_HOURS_S,
    });
  }
  if (method === 'apps.manifest.create') {
    const refused = configurationRefusal(request);
    if (refused) return json(response, 200, { ok: false, error: refused });
    const manifest = new URLSearchParams(body).get('manifest');
    if (!manifest) return json(response, 200, { ok: false, error: 'invalid_manifest' });
    // The first create is the app the fake has always answered for; each later one is a new app.
    let app = apps.find((candidate) => !candidate.created);
    if (!app) {
      app = appNumbered(apps.length + 1);
      app.installed = false;
      apps.push(app);
    }
    app.created = true;
    // The bot scopes the manifest asked for: a method that needs one it did not is refused.
    try {
      const parsed = JSON.parse(manifest);
      const bot = parsed && parsed.oauth_config && parsed.oauth_config.scopes;
      app.scopes = Array.isArray(bot && bot.bot) ? bot.bot : [];
      app.manifest = parsed;
    } catch {
      app.scopes = [];
      app.manifest = undefined;
    }
    app.takesMessages = manifestTakesMessages(app.manifest);
    return json(response, 200, {
      ok: true,
      app_id: app.appId,
      credentials: { client_id: app.clientId, client_secret: app.clientSecret },
    });
  }
  if (method === 'apps.manifest.export' || method === 'apps.manifest.update') {
    // W12V-7: the configuration token reads and changes the manifest of an app it created.
    const refused = configurationRefusal(request);
    if (refused) return json(response, 200, { ok: false, error: refused });
    const form = readArguments(url, request, body);
    const app = apps.find((candidate) => candidate.appId === form.get('app_id'));
    if (!app || !app.created || app.deleted) {
      return json(response, 200, { ok: false, error: 'app_not_found' });
    }
    if (method === 'apps.manifest.export') {
      return json(response, 200, { ok: true, manifest: app.manifest || {} });
    }
    let parsed;
    try {
      parsed = JSON.parse(form.get('manifest') || '');
    } catch {
      return json(response, 200, { ok: false, error: 'invalid_manifest' });
    }
    const scopes = parsed && parsed.oauth_config && parsed.oauth_config.scopes;
    const bot = Array.isArray(scopes && scopes.bot) ? scopes.bot : [];
    const permissionsUpdated = JSON.stringify(bot) !== JSON.stringify(app.scopes || []);
    app.manifest = parsed;
    app.scopes = bot;
    app.takesMessages = manifestTakesMessages(parsed);
    return json(response, 200, {
      ok: true,
      app_id: app.appId,
      permissions_updated: permissionsUpdated,
    });
  }
  if (method === 'apps.manifest.delete') {
    // S4: a manager app's configuration token deletes only the apps it created.
    const refused = configurationRefusal(request);
    if (refused) return json(response, 200, { ok: false, error: refused });
    const appId = readArguments(url, request, body).get('app_id');
    const app = apps.find((candidate) => candidate.appId === appId);
    if (!app || !app.created || app.deleted) {
      return json(response, 200, { ok: false, error: 'invalid_app_id' });
    }
    app.deleted = true;
    revokeBot(app);
    return json(response, 200, { ok: true });
  }
  if (method === 'apps.uninstall') {
    // S4: revokes every token of the installation the bearer belongs to.
    const app = botOf(request);
    if (!app) return json(response, 200, { ok: false, error: 'invalid_auth' });
    const form = readArguments(url, request, body);
    if (form.get('client_id') !== app.clientId || form.get('client_secret') !== app.clientSecret) {
      return json(response, 200, { ok: false, error: 'bad_client_secret' });
    }
    revokeBot(app);
    return json(response, 200, { ok: true });
  }
  if (method === 'auth.revoke' && revokedConfigurationTokens.has(bearerOf(request))) {
    return json(response, 200, { ok: false, error: 'token_revoked' });
  }
  if (method === 'auth.revoke' && bearerOf(request) === configuration.token) {
    // The token alone: its refresh token still rotates.
    revokedConfigurationTokens.add(configuration.token);
    return json(response, 200, { ok: true, revoked: true });
  }
  if (method === 'auth.revoke' && botOf(request)) {
    // S1: the bot user is deactivated and leaves its channels; the app stays.
    revokeBot(botOf(request));
    return json(response, 200, { ok: true, revoked: true });
  }
  // Validates a manifest with the configuration token (`check:access`, 11-AI): the token must be
  // the configuration token and the manifest JSON that names a redirect and bot scopes.
  if (method === 'apps.manifest.validate') {
    const refused = configurationRefusal(request);
    if (refused) return json(response, 200, { ok: false, error: refused });
    let manifest;
    try {
      manifest = JSON.parse(new URLSearchParams(body).get('manifest') || '');
    } catch {
      return json(response, 200, { ok: false, error: 'invalid_manifest' });
    }
    const oauth = manifest && manifest.oauth_config;
    if (
      !oauth ||
      !Array.isArray(oauth.redirect_urls) ||
      !Array.isArray(oauth.scopes && oauth.scopes.bot)
    ) {
      return json(response, 200, { ok: false, error: 'invalid_manifest' });
    }
    return json(response, 200, { ok: true });
  }
  if (method === 'oauth.v2.access') {
    const form = new URLSearchParams(body);
    const app = apps.find((candidate) => candidate.code === form.get('code'));
    if (
      !app ||
      app.deleted ||
      form.get('client_secret') !== app.clientSecret ||
      (form.get('client_id') !== null && form.get('client_id') !== app.clientId)
    ) {
      return json(response, 200, { ok: false, error: 'invalid_code' });
    }
    // An install, or a renewal reinstalling the same app, issues its bot token afresh; the bot
    // is in no channel until it joins or is invited (S1).
    app.installed = true;
    revokedTokens.delete(app.botToken);
    return json(response, 200, {
      ok: true,
      access_token: app.botToken,
      bot_user_id: app.botUserId,
      team: { id: 'T_DAY0' },
    });
  }
  if (method === 'apps.connections.open') {
    // K1: an app-level token, in the Authorization header, opens a single-use WebSocket URL.
    const bearer = bearerOf(request);
    const app = apps.find(
      (candidate) =>
        !candidate.deleted && candidate.appLevelToken && candidate.appLevelToken === bearer,
    );
    if (!app) return json(response, 200, { ok: false, error: 'invalid_auth' });
    const ticket = randomBytes(12).toString('hex');
    tickets.set(ticket, app.appId);
    const origin =
      process.env.FAKE_SLACK_SOCKET_ORIGIN ||
      `ws://${request.headers.host || `fake-slack:${port}`}`;
    return json(response, 200, { ok: true, url: `${origin}/link/?ticket=${ticket}` });
  }
  const bot = botOf(request);
  if (!bot) return json(response, 200, { ok: false, error: 'invalid_auth' });
  if (method === 'auth.test') {
    return json(response, 200, { ok: true, user_id: bot.botUserId, team_id: 'T_DAY0' });
  }
  if (method === 'conversations.join') {
    // RM4: a bot joins a public channel itself (`channels:join`); a private one needs a person.
    const channel = PUBLIC_CHANNELS.find(
      (candidate) => candidate.id === readArguments(url, request, body).get('channel'),
    );
    if (!channel) return json(response, 200, { ok: false, error: 'channel_not_found' });
    // The first app, which the fake answered for before any manifest, holds every scope.
    if (bot.scopes && !bot.scopes.includes('channels:join')) {
      return json(response, 200, { ok: false, error: 'missing_scope' });
    }
    const joined = memberships.get(bot.botUserId) || new Set();
    joined.add(channel.id);
    memberships.set(bot.botUserId, joined);
    return json(response, 200, {
      ok: true,
      channel: { id: channel.id, name: channel.name, is_member: true },
    });
  }
  if (method === 'users.lookupByEmail') {
    const email = readArguments(url, request, body).get('email');
    if (!email) {
      return json(response, 200, { ok: false, error: 'users_not_found' });
    }
    const person = people.get(email.trim().toLowerCase());
    return json(response, 200, {
      ok: true,
      user: person
        ? { id: person.id, real_name: person.name, deleted: false }
        : { id: 'U_DAY0_MANAGER', real_name: 'Day0 operator', deleted: false },
    });
  }
  if (method === 'conversations.open') {
    const users =
      readArguments(url, request, body).get('users') || jsonArguments(request, body).users;
    const person = [...people.values()].find((candidate) => candidate.id === users);
    return json(response, 200, {
      ok: true,
      channel: { id: person ? person.dm : 'D_DAY0_MANAGER' },
    });
  }
  if (method === 'conversations.list') {
    const joined = memberships.get(bot.botUserId) || new Set();
    return json(response, 200, {
      ok: true,
      channels: PUBLIC_CHANNELS.map((channel) => ({
        id: channel.id,
        name: channel.name,
        is_member: joined.has(channel.id),
      })),
      response_metadata: { next_cursor: '' },
    });
  }
  if (method === 'conversations.history' || method === 'conversations.replies') {
    const given = readArguments(url, request, body);
    if (!CHANNELS.includes(given.get('channel') || '')) {
      return json(response, 200, { ok: false, error: 'channel_not_found' });
    }
    if (method === 'conversations.history') {
      // What the manager typed to this bot's app, newest first, after `oldest` when given.
      const oldest = Number(given.get('oldest') || 0);
      const typed = managerMessages
        .filter(
          (message) =>
            message.appId === bot.appId &&
            message.channel === given.get('channel') &&
            message.threadTs === undefined &&
            Number(message.ts) > oldest,
        )
        .reverse()
        .map((message) => ({
          type: 'message',
          user: message.user,
          text: message.text,
          ts: message.ts,
        }));
      return json(response, 200, { ok: true, messages: typed, has_more: false });
    }
    const ts = given.get('ts');
    if (!ts) return json(response, 200, { ok: false, error: 'invalid_arguments' });
    return json(response, 200, {
      ok: true,
      messages: [{ type: 'message', user: 'U_DAY0_MANAGER', ts, thread_ts: ts }],
      has_more: false,
    });
  }
  if (method === 'chat.postMessage') {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(response, 200, { ok: false, error: 'invalid_json' });
    }
    if (!CHANNELS.includes(payload.channel)) {
      return json(response, 200, { ok: false, error: 'not_in_channel' });
    }
    if (typeof payload.text !== 'string' || payload.text.trim() === '') {
      return json(response, 200, { ok: false, error: 'invalid_arguments' });
    }
    postsByChannel.set(payload.channel, (postsByChannel.get(payload.channel) || 0) + 1);
    const ts = `1787817600.${String(calls.get(method) || 1).padStart(6, '0')}`;
    messages.set(messageKey(payload.channel, ts), {
      channel: payload.channel,
      ts,
      appId: bot.appId,
      ...markupOf(payload.text),
      ...shapeOf(payload.blocks),
      edits: 0,
    });
    return json(response, 200, {
      ok: true,
      channel: payload.channel,
      ts,
      message: { ts },
    });
  }
  if (method === 'chat.update') {
    // K3b: blocks given replace the message's (an empty array removes them); text given with no
    // blocks removes them and renders the text; a bot edits only the messages it posted.
    const payload = jsonArguments(request, body);
    const message = messages.get(messageKey(payload.channel, payload.ts));
    if (!message) return json(response, 200, { ok: false, error: 'message_not_found' });
    if (message.appId !== bot.appId) {
      return json(response, 200, { ok: false, error: 'cant_update_message' });
    }
    const text = typeof payload.text === 'string' ? payload.text : undefined;
    const blocks = Array.isArray(payload.blocks) ? payload.blocks : undefined;
    if (text === undefined && blocks === undefined) {
      return json(response, 200, { ok: false, error: 'no_text' });
    }
    if (blocks !== undefined) Object.assign(message, shapeOf(blocks));
    else if (text !== undefined) Object.assign(message, shapeOf([]));
    if (text !== undefined) Object.assign(message, markupOf(text));
    message.edits += 1;
    return json(response, 200, {
      ok: true,
      channel: message.channel,
      ts: message.ts,
      text: message.text,
    });
  }
  return json(response, 200, { ok: false, error: 'method_not_supported_by_fake' });
});

// ---- Socket Mode (K1): a minimal RFC 6455 server, text frames only ----

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Send one unmasked text (or close) frame to a client. */
function sendFrame(socket, text, opcode = 0x1) {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
  socket.write(Buffer.concat([header, payload]));
}

function bigLength(length) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

/** Read every whole client frame off the buffer; answers the rest still to come. */
function readFrames(connection, onText) {
  let buffer = connection.buffer;
  for (;;) {
    if (buffer.length < 2) break;
    const opcode = buffer[0] & 0x0f;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = (buffer[1] & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) break;
    const mask = buffer.subarray(offset, offset + maskLength);
    const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
    if (masked)
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    buffer = buffer.subarray(offset + maskLength + length);
    if (opcode === 0x8) {
      sendFrame(connection.socket, '', 0x8);
      connection.socket.end();
      break;
    }
    connection.alive = true;
    if (opcode === 0x9) sendFrame(connection.socket, payload.toString(), 0xa);
    if (opcode === 0x1) onText(payload.toString());
  }
  connection.buffer = buffer;
}

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url || '/', 'http://fake-slack');
  const ticket = url.searchParams.get('ticket') || '';
  const appId = tickets.get(ticket);
  const open = [...sockets].filter((connection) => connection.appId === appId).length;
  if (url.pathname !== '/link/' || appId === undefined || open >= MAX_CONNECTIONS_PER_APP) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  tickets.delete(ticket);
  const accept = createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}${WEBSOCKET_GUID}`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const connection = { socket, appId, buffer: Buffer.alloc(0), waiting: new Map(), alive: true };
  sockets.add(connection);
  socket.on('data', (chunk) => {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    readFrames(connection, (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const acknowledged = connection.waiting.get(message.envelope_id);
      if (acknowledged) acknowledged();
    });
  });
  const close = () => sockets.delete(connection);
  socket.on('close', close);
  socket.on('error', close);
  sendFrame(
    socket,
    JSON.stringify({
      type: 'hello',
      num_connections: open + 1,
      connection_info: { app_id: appId },
      debug_info: { host: 'fake-slack', approximate_connection_time: 3600 },
    }),
  );
});

setInterval(() => {
  for (const connection of sockets) {
    if (!connection.alive) {
      sockets.delete(connection);
      connection.socket.destroy();
      continue;
    }
    connection.alive = false;
    sendFrame(connection.socket, 'ping', 0x9);
  }
}, PING_MS).unref();

let pressCount = 0;

/**
 * A person pressing one of a message's buttons (K3): the app's block_actions payload, sent as an
 * envelope down one of its open connections, and whether the app acknowledged it in time. With no
 * connection open the press reaches nobody, as Slack then shows the person an error.
 */
async function press({ channel, ts, button, userId }) {
  const message = messages.get(messageKey(channel, ts));
  if (!message) return { delivered: false, error: 'message_not_found' };
  const element = message.buttons.find(
    (candidate) => candidate.actionId === `day0.decision.${button}`,
  );
  if (!element) return { delivered: false, error: 'no_such_button' };
  const connection = [...sockets].find((candidate) => candidate.appId === message.appId);
  pressCount += 1;
  const actionTs = `${Math.floor(Date.now() / 1000)}.${String(pressCount).padStart(6, '0')}`;
  if (!connection) {
    presses.push({ channel, ts, button, actionTs, delivered: false });
    return { delivered: false, error: 'no_socket_connection' };
  }
  const envelopeId = randomBytes(8).toString('hex');
  const payload = {
    type: 'block_actions',
    user: { id: userId || 'U_DAY0_MANAGER' },
    team: { id: 'T_DAY0' },
    api_app_id: message.appId,
    container: { type: 'message', message_ts: ts, channel_id: channel, is_ephemeral: false },
    channel: { id: channel },
    message: { ts },
    actions: [
      {
        action_id: element.actionId,
        block_id: element.blockId,
        value: element.value,
        type: 'button',
        action_ts: actionTs,
      },
    ],
  };
  const acknowledged = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ACK_WAIT_MS);
    connection.waiting.set(envelopeId, () => {
      clearTimeout(timer);
      resolve(true);
    });
    sendFrame(
      connection.socket,
      JSON.stringify({
        envelope_id: envelopeId,
        type: 'interactive',
        payload,
        accepts_response_payload: false,
      }),
    );
  });
  connection.waiting.delete(envelopeId);
  presses.push({ channel, ts, button, actionTs, delivered: true, acknowledged });
  return { delivered: true, acknowledged, envelopeId, actionTs };
}

server.listen(port, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
