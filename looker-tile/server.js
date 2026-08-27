/**
 * The Looker pipeline tile: a synthetic system with a web UI and no API.
 *
 * Day0's claim is that it connects to any system with an MCP server or a
 * documented HTTP API, and is honest about systems with neither. This is the
 * "neither": a small internal dashboard of the kind every company has, which
 * exposes no integration surface at all, so the only way to change the number
 * on it is the way a person would - open it, sign in, type, save. It exists to
 * make the browser floor demonstrable against something real rather than
 * against a mock, and it is deliberately unremarkable.
 *
 * It holds no data worth protecting and is never published outside the compose
 * network. The one credential is read from the environment and matched in
 * constant time; sessions are in-memory and die with the process.
 */

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.LOOKER_TILE_PORT || 8080);
const USERNAME = process.env.LOOKER_TILE_USER || 'revops';
const PASSWORD = process.env.LOOKER_TILE_PASSWORD || 'pipeline-tile-local';
const SESSION_COOKIE = 'looker_session';

/** Sessions live in memory: this is a demo system, not a store of record. */
const sessions = new Map();

/** The one editable figure, and who last changed it. */
const tile = {
  value: '68%',
  updatedAt: null,
  updatedBy: null,
};

function constantTimeEquals(offered, expected) {
  const a = Buffer.from(String(offered), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format the audit stamp the way the dashboard has always shown it. */
function auditLine() {
  if (!tile.updatedAt || !tile.updatedBy) return 'Never updated since this instance started.';
  const when = new Date(tile.updatedAt).toISOString().replace('T', ' ').slice(0, 19);
  return `Last updated by ${tile.updatedBy} at ${when} UTC`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1f2933;
  }
  main { width: min(680px, calc(100vw - 48px)); padding: 24px 0 48px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .brand-mark {
    width: 26px; height: 26px; border-radius: 7px; background: #4b56d2;
    display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px;
  }
  .brand-name { font-weight: 600; letter-spacing: -0.01em; }
  .card {
    background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 24px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }
  h1 { margin: 0 0 4px; font-size: 19px; letter-spacing: -0.015em; }
  .sub { margin: 0 0 20px; color: #6b7684; font-size: 13px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #4b5563; margin-bottom: 6px; }
  input {
    width: 100%; padding: 9px 11px; border: 1px solid #d4d8de; border-radius: 8px;
    font: inherit; background: #fff; color: inherit;
  }
  input:focus-visible { outline: 2px solid #4b56d2; outline-offset: 1px; border-color: #4b56d2; }
  .field + .field { margin-top: 14px; }
  button {
    margin-top: 18px; padding: 9px 16px; border: 0; border-radius: 8px;
    background: #4b56d2; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #3f49bd; }
  button:focus-visible { outline: 2px solid #1f2933; outline-offset: 2px; }
  .tile { display: flex; align-items: baseline; gap: 12px; margin: 6px 0 18px; }
  .metric { font-size: 44px; font-weight: 650; letter-spacing: -0.03em; }
  .metric-label { color: #6b7684; font-size: 13px; }
  .audit {
    margin: 18px 0 0; padding-top: 14px; border-top: 1px solid #eef0f3;
    color: #6b7684; font-size: 12px;
  }
  .error { margin: 14px 0 0; color: #b42318; font-size: 13px; }
  .saved { margin: 14px 0 0; color: #067647; font-size: 13px; }
  .foot { margin-top: 16px; color: #8b95a3; font-size: 11px; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="brand"><span class="brand-mark" aria-hidden="true">L</span><span class="brand-name">Looker</span></div>
  ${body}
  <p class="foot">Internal RevOps dashboard. No API or integration surface is available.</p>
</main>
</body>
</html>`;
}

function loginPage(error) {
  return page(
    'Sign in - Looker',
    `<form class="card" method="post" action="/login">
    <h1>Sign in</h1>
    <p class="sub">RevOps pipeline dashboard</p>
    <div class="field">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Sign in</button>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  </form>`,
  );
}

function dashboardPage(user, saved) {
  return page(
    'Pipeline coverage - Looker',
    `<form class="card" method="post" action="/tile">
    <h1>Pipeline coverage</h1>
    <p class="sub">Q3 close &middot; RevOps</p>
    <div class="tile">
      <span class="metric">${escapeHtml(tile.value)}</span>
      <span class="metric-label">of target covered</span>
    </div>
    <div class="field">
      <label for="coverage">Pipeline coverage</label>
      <input id="coverage" name="coverage" value="${escapeHtml(tile.value)}" required>
    </div>
    <button type="submit">Save</button>
    ${saved ? '<p class="saved">Saved.</p>' : ''}
    <p class="audit">${escapeHtml(auditLine())}</p>
  </form>`,
  );
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function sessionUser(req) {
  return sessions.get(readCookie(req.headers.cookie, SESSION_COOKIE));
}

async function formBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8_192) throw new Error('body too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://looker-tile');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    const user = sessionUser(req);
    return send(res, 200, user ? dashboardPage(user, false) : loginPage(undefined));
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    const form = await formBody(req);
    const ok =
      constantTimeEquals(form.get('username') ?? '', USERNAME) &&
      constantTimeEquals(form.get('password') ?? '', PASSWORD);
    if (!ok) return send(res, 401, loginPage('That username and password do not match.'));
    const token = randomBytes(24).toString('hex');
    sessions.set(token, USERNAME);
    return send(res, 200, dashboardPage(USERNAME, false), {
      'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`,
    });
  }

  if (req.method === 'POST' && url.pathname === '/tile') {
    const user = sessionUser(req);
    if (!user) return send(res, 401, loginPage('Your session has expired. Sign in again.'));
    const form = await formBody(req);
    const value = (form.get('coverage') ?? '').trim().slice(0, 24);
    if (!value) return send(res, 400, dashboardPage(user, false));
    tile.value = value;
    tile.updatedBy = user;
    tile.updatedAt = Date.now();
    return send(res, 200, dashboardPage(user, true));
  }

  return send(res, 404, page('Not found', '<div class="card"><h1>Not found</h1></div>'));
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`looker pipeline tile listening on ${PORT}\n`);
});
