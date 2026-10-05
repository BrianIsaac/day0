/**
 * The fake Linear's listener: `linear.js` served over Node's own HTTPS (or HTTP, for a test that
 * dials it in process) on the compose network under the `test` profile. Never a production
 * service: anyone who reaches it may act as any of its people.
 *
 *   FAKE_LINEAR_PORT            the port it listens on (default 443, so Linear's own addresses
 *                               resolve to it on a bed with no port named)
 *   FAKE_LINEAR_TLS_DIR         a directory holding cert.pem and key.pem; HTTPS when it has both,
 *                               HTTP otherwise (fake-linear/make-tls.sh writes them)
 *   FAKE_LINEAR_REDIRECT_URIS   the default apps' redirect URIs, comma-separated (default
 *                               http://localhost:3000/api/oauth/linear)
 *   FAKE_LINEAR_APPS            the OAuth apps as JSON, `[{ clientId, clientSecret, name,
 *                               clientCredentials, redirectUris, id?, appUserId? }]`; the shared
 *                               app and one employee's own app by default
 *   FAKE_LINEAR_PEOPLE          the people as JSON, `[{ id, name, displayName, email, admin,
 *                               apiKey? }]`; an administrator and a member by default
 *   FAKE_LINEAR_WORKSPACE       the teams, projects and labels as JSON, `{ urlKey?, teams?,
 *                               projects?, labels? }`; one RevOps team with a Q3 close project
 *   FAKE_LINEAR_SIGNED_IN       the person the authorise page acts as, by id or address; the first
 *                               administrator by default
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { createLinear, defaultApps } from './linear.js';

/**
 * A JSON setting, or the default when it is unset.
 *
 * @template T
 * @param {string} name
 * @param {T} fallback
 * @returns {T}
 */
function jsonSetting(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`${name} is not JSON: ${String(error)}`);
    process.exit(2);
  }
}

const redirectUris = (
  process.env.FAKE_LINEAR_REDIRECT_URIS || 'http://localhost:3000/api/oauth/linear'
)
  .split(',')
  .map((uri) => uri.trim())
  .filter((uri) => uri !== '');
const port = Number(process.env.FAKE_LINEAR_PORT || 443);
const tlsDir = process.env.FAKE_LINEAR_TLS_DIR;
const certPath = tlsDir ? join(tlsDir, 'cert.pem') : '';
const keyPath = tlsDir ? join(tlsDir, 'key.pem') : '';
const secure = Boolean(tlsDir) && existsSync(certPath) && existsSync(keyPath);

const people = jsonSetting('FAKE_LINEAR_PEOPLE', undefined);
const signedIn = process.env.FAKE_LINEAR_SIGNED_IN?.trim();
const linear = createLinear({
  apps: jsonSetting('FAKE_LINEAR_APPS', defaultApps(redirectUris)),
  ...(people ? { people } : {}),
  workspace: jsonSetting('FAKE_LINEAR_WORKSPACE', {}),
  ...(signedIn ? { signedIn } : {}),
});

/**
 * Hand one Node request to the double and write its answer back. The URL is rebuilt on the host
 * the request named, so the double sees `https://api.linear.app/oauth/token` as Day0 sent it.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function serve(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const url = new URL(
    request.url ?? '/',
    `${secure ? 'https' : 'http'}://${request.headers.host ?? 'fake-linear'}`,
  );
  const answer = await linear.handle(
    new Request(url, {
      method: request.method,
      headers,
      ...(body && request.method !== 'GET' && request.method !== 'HEAD' ? { body } : {}),
    }),
  );
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
}

/** @type {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} */
const listener = (request, response) => {
  serve(request, response).catch((error) => {
    console.error(
      JSON.stringify({ level: 'error', msg: 'fake-linear request failed', error: String(error) }),
    );
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
};

const server = secure
  ? createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, listener)
  : createHttpServer(listener);
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'fake-linear listening', port, secure }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
