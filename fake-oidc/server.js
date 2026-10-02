/**
 * The test issuer's listener: `issuer.js` served over Node's own HTTPS (or
 * HTTP, for a test that dials it in process) on the compose network under the
 * `test` profile. Never a production issuer: anyone who reaches it may sign in
 * as any of its people.
 *
 *   FAKE_OIDC_ISSUER          the issuer URL tokens carry in `iss` (required)
 *   FAKE_OIDC_PORT            the port it listens on (default 8443)
 *   FAKE_OIDC_CLIENT_ID       the one registered client (default day0-app)
 *   FAKE_OIDC_CLIENT_SECRET   its secret (default day0-test-client-secret)
 *   FAKE_OIDC_REDIRECT_URIS   its redirect URIs, comma-separated (required)
 *   FAKE_OIDC_PEOPLE          the people as JSON, `[{ id, subject?, claims }]`;
 *                             the two in acme.test and one outside it by default
 *   FAKE_OIDC_TOKEN_SECONDS   the ID token lifetime (default 300)
 *   FAKE_OIDC_TLS_DIR         a directory holding cert.pem and key.pem; HTTPS
 *                             when it has both, HTTP otherwise
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { createIssuer, DEFAULT_PEOPLE, DEFAULT_TOKEN_SECONDS } from './issuer.js';

const issuerUrl = process.env.FAKE_OIDC_ISSUER;
const redirectUris = (process.env.FAKE_OIDC_REDIRECT_URIS ?? '')
  .split(',')
  .map((uri) => uri.trim())
  .filter((uri) => uri !== '');
if (!issuerUrl || redirectUris.length === 0) {
  console.error('FAKE_OIDC_ISSUER and FAKE_OIDC_REDIRECT_URIS are required.');
  process.exit(2);
}

const port = Number(process.env.FAKE_OIDC_PORT || 8443);
const tlsDir = process.env.FAKE_OIDC_TLS_DIR;
const certPath = tlsDir ? join(tlsDir, 'cert.pem') : '';
const keyPath = tlsDir ? join(tlsDir, 'key.pem') : '';
const secure = Boolean(tlsDir) && existsSync(certPath) && existsSync(keyPath);

const issuer = createIssuer({
  issuer: issuerUrl,
  clients: [
    {
      id: process.env.FAKE_OIDC_CLIENT_ID || 'day0-app',
      secret: process.env.FAKE_OIDC_CLIENT_SECRET || 'day0-test-client-secret',
      redirectUris,
    },
  ],
  people: process.env.FAKE_OIDC_PEOPLE ? JSON.parse(process.env.FAKE_OIDC_PEOPLE) : DEFAULT_PEOPLE,
  tokenSeconds: Number(process.env.FAKE_OIDC_TOKEN_SECONDS || DEFAULT_TOKEN_SECONDS),
});

/**
 * Hand one Node request to the issuer and write its answer back.
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
  const url = new URL(request.url ?? '/', issuer.issuer);
  const answer = await issuer.handle(
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
      JSON.stringify({ level: 'error', msg: 'fake-oidc request failed', error: String(error) }),
    );
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
};

const server = secure
  ? createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, listener)
  : createHttpServer(listener);
server.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'fake-oidc listening',
      issuer: issuer.issuer,
      port,
      secure,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
