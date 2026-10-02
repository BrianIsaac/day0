import { createServer } from 'node:http';

const port = Number(process.env.FAKE_SLACK_PORT || 8090);
const botToken = 'xoxb-day0-fake-dedicated-token';
const clientSecret = 'day0-fake-client-secret';
const calls = new Map();
const requestLog = [];
// chat.postMessage counts per channel, never the text: a handover between two
// managers shows as one post in each of their DMs.
const postsByChannel = new Map();

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

function authorised(request, expected = botToken) {
  return request.headers.authorization === `Bearer ${expected}`;
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
    });
  }
  if (url.pathname === '/reset' && request.method === 'POST') {
    calls.clear();
    requestLog.length = 0;
    postsByChannel.clear();
    return json(response, 200, { ok: true });
  }
  if (url.pathname === '/oauth/v2/authorize' && request.method === 'GET') {
    count('oauth.v2.authorize');
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    if (!redirect || !state) return json(response, 400, { ok: false, error: 'bad_request' });
    const destination = new URL(redirect);
    destination.searchParams.set('code', 'day0-fake-authorisation-code');
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

  if (method === 'apps.manifest.create') {
    if (!authorised(request, 'xoxe-day0-fake-configuration-token')) {
      return json(response, 200, { ok: false, error: 'invalid_auth' });
    }
    const manifest = new URLSearchParams(body).get('manifest');
    if (!manifest) return json(response, 200, { ok: false, error: 'invalid_manifest' });
    return json(response, 200, {
      ok: true,
      app_id: 'A_DAY0_FAKE',
      credentials: { client_id: '111.day0', client_secret: clientSecret },
    });
  }
  if (method === 'oauth.v2.access') {
    const form = new URLSearchParams(body);
    if (
      form.get('client_secret') !== clientSecret ||
      form.get('code') !== 'day0-fake-authorisation-code'
    ) {
      return json(response, 200, { ok: false, error: 'invalid_code' });
    }
    return json(response, 200, {
      ok: true,
      access_token: botToken,
      bot_user_id: 'U_DAY0_BOT',
      team: { id: 'T_DAY0' },
    });
  }
  if (!authorised(request)) return json(response, 200, { ok: false, error: 'invalid_auth' });
  if (method === 'auth.test') {
    return json(response, 200, { ok: true, user_id: 'U_DAY0_BOT', team_id: 'T_DAY0' });
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
    return json(response, 200, {
      ok: true,
      channels: [
        { id: 'C_REVOPS', name: 'revops', is_member: false },
        { id: 'C_REVOPS_ASKS', name: 'revops-asks', is_member: false },
      ],
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
