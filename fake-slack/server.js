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
}

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

function authorisedConfiguration(request) {
  return request.headers.authorization === `Bearer ${configuration.token}`;
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
      configurationRotations: configuration.rotations,
      // Channel ids each live app's bot is in, by app id.
      memberships: Object.fromEntries(
        apps
          .filter((app) => app.created && !app.deleted)
          .map((app) => [app.appId, [...(memberships.get(app.botUserId) || [])]]),
      ),
    });
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
    if (!authorisedConfiguration(request)) {
      return json(response, 200, { ok: false, error: 'invalid_auth' });
    }
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
    return json(response, 200, {
      ok: true,
      app_id: app.appId,
      credentials: { client_id: app.clientId, client_secret: app.clientSecret },
    });
  }
  if (method === 'apps.manifest.delete') {
    // S4: a manager app's configuration token deletes only the apps it created.
    if (!authorisedConfiguration(request)) {
      return json(response, 200, { ok: false, error: 'invalid_auth' });
    }
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
  if (method === 'auth.revoke' && botOf(request)) {
    // S1: the bot user is deactivated and leaves its channels; the app stays.
    revokeBot(botOf(request));
    return json(response, 200, { ok: true, revoked: true });
  }
  // Validates a manifest with the configuration token (`check:access`, 11-AI): the token must be
  // the configuration token and the manifest JSON that names a redirect and bot scopes.
  if (method === 'apps.manifest.validate') {
    if (!authorisedConfiguration(request)) {
      return json(response, 200, { ok: false, error: 'invalid_auth' });
    }
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
      return json(response, 200, { ok: true, messages: [], has_more: false });
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
    return json(response, 200, {
      ok: true,
      channel: payload.channel,
      ts,
      message: { ts },
    });
  }
  return json(response, 200, { ok: false, error: 'method_not_supported_by_fake' });
});

server.listen(port, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
