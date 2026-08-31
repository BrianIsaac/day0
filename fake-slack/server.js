import { createServer } from 'node:http';

const port = Number(process.env.FAKE_SLACK_PORT || 8090);
const botToken = 'xoxb-day0-fake-dedicated-token';
const clientSecret = 'day0-fake-client-secret';
const calls = new Map();
const requestLog = [];

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
    });
  }
  if (url.pathname === '/reset' && request.method === 'POST') {
    calls.clear();
    requestLog.length = 0;
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
    return json(response, 200, {
      ok: true,
      user: { id: 'U_DAY0_MANAGER', real_name: 'Day0 operator', deleted: false },
    });
  }
  if (method === 'conversations.open') {
    return json(response, 200, { ok: true, channel: { id: 'D_DAY0_MANAGER' } });
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
  if (method === 'chat.postMessage') {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(response, 200, { ok: false, error: 'invalid_json' });
    }
    if (!['D_DAY0_MANAGER', 'C_REVOPS', 'C_REVOPS_ASKS'].includes(payload.channel)) {
      return json(response, 200, { ok: false, error: 'not_in_channel' });
    }
    if (typeof payload.text !== 'string' || payload.text.trim() === '') {
      return json(response, 200, { ok: false, error: 'invalid_arguments' });
    }
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
