/**
 * Which hosts Node sends to a proxy under `NODE_USE_ENV_PROXY=1`, for each `NO_PROXY` written as
 * IT writes one (wave 18, 18-P; W17-R27). Node has two clients that read it: `fetch` (undici's
 * environment agent) and `node:http`'s own agent, and they do not read a list alike. Each case
 * runs in a child Node of this one against a proxy on loopback that answers nothing, and a row is
 * proxied when that proxy saw the request. A host kept out is dialled directly and fails to
 * resolve, which is all the probe needs of it.
 *
 *   node tests/fixtures/proxy/probe-no-proxy.mjs > tests/fixtures/proxy/node-<version>-no-proxy.json
 *
 * `check:setup`'s reading of `NO_PROXY` is tested against the file this printed on Node 22.23.2.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Each `NO_PROXY` as written, and the host and port asked for under it. */
const CASES = [
  ['corp.invalid', 'corp.invalid'],
  ['corp.invalid', 'sub.corp.invalid'],
  ['.corp.invalid', 'corp.invalid'],
  ['.corp.invalid', 'sub.corp.invalid'],
  ['*.corp.invalid', 'corp.invalid'],
  ['*.corp.invalid', 'sub.corp.invalid'],
  ['corp.invalid:8080', 'corp.invalid:8080'],
  ['corp.invalid:8080', 'corp.invalid:9090'],
  ['corp.invalid:8080', 'corp.invalid'],
  ['10.0.0.0/8', '10.1.2.3'],
  ['10.1.2.3', '10.1.2.3'],
  ['*', 'corp.invalid'],
  ['CORP.INVALID', 'corp.invalid'],
  ['other.invalid,corp.invalid', 'corp.invalid'],
  ['other.invalid,*', 'corp.invalid'],
  ['*corp.invalid', 'corp.invalid'],
  ['*corp.invalid', 'xcorp.invalid'],
  ['corp.invalid:443', 'corp.invalid'],
  ['corp.invalid:80', 'corp.invalid'],
  [' corp.invalid , other.invalid', 'corp.invalid'],
  ['other.invalid corp.invalid', 'corp.invalid'],
];

const FETCH = `
const abort = new AbortController();
setTimeout(() => abort.abort(), 1500);
fetch(process.argv[1], { signal: abort.signal }).catch(() => {}).finally(() => process.exit(0));
`;

const NODE_HTTP = `
const target = new URL(process.argv[1]);
const client = require(target.protocol === 'https:' ? 'node:https' : 'node:http');
client.get(target, () => process.exit(0)).on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 1500);
`;

const seen = [];
const proxy = createServer((request, response) => {
  seen.push(request.url);
  response.writeHead(502).end();
});
proxy.on('connect', (request, socket) => {
  seen.push(`CONNECT ${request.url}`);
  socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
});
await new Promise((listening) => proxy.listen(0, '127.0.0.1', listening));
const address = `http://127.0.0.1:${proxy.address().port}`;

const rows = [];
for (const [noProxy, host] of CASES) {
  for (const [client, code] of [
    ['fetch', FETCH],
    ['node:http', NODE_HTTP],
  ]) {
    for (const scheme of ['http', 'https']) {
      seen.length = 0;
      await run(process.execPath, ['-e', code, `${scheme}://${host}/probe`], {
        env: {
          PATH: process.env.PATH,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: address,
          HTTPS_PROXY: address,
          NO_PROXY: noProxy,
        },
        timeout: 5_000,
      }).catch(() => undefined);
      // The proxy's own handler runs on this loop: give it the request the child sent.
      await new Promise((settled) => setTimeout(settled, 50));
      rows.push({ client, scheme, noProxy, host, proxied: seen.length > 0 });
    }
  }
}
proxy.close();
process.stdout.write(
  `${JSON.stringify(
    {
      node: process.version,
      probe: 'tests/fixtures/proxy/probe-no-proxy.mjs',
      rows,
    },
    null,
    2,
  )}\n`,
);
