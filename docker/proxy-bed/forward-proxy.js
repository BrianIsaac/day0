/**
 * A bed's forward proxy (wave 17, 17-P; RM31 (a)): the one route out of a bed whose networks have
 * none of their own, standing in for the HTTP proxy a customer's network puts between Day0 and
 * the internet. It tunnels a CONNECT (https, and the Slack socket's wss) and forwards a request
 * in absolute form, http or https, and prints one line for each naming who asked and for what,
 * which is the bed's evidence of what took the proxy. With FORWARD_PROXY_AUTH (`user:password`)
 * it asks for those credentials, as an authenticating proxy does, and refuses a client without
 * them with 407; the credentials are never printed. Never a production proxy: it carries
 * anything anywhere. Only docker/proxy.bed.yml starts it.
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';

const port = Number(process.env.FORWARD_PROXY_PORT || 3128);
const credentials = process.env.FORWARD_PROXY_AUTH
  ? `Basic ${Buffer.from(process.env.FORWARD_PROXY_AUTH).toString('base64')}`
  : undefined;
const CHALLENGE = 'Basic realm="day0-bed"';

function log(line) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

/** Why a request is refused for its credentials, or undefined when it may pass. */
function refusal(request) {
  if (credentials === undefined) return undefined;
  const given = request.headers['proxy-authorization'];
  if (given === undefined) return 'no credentials';
  return given === credentials ? undefined : 'wrong credentials';
}

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200).end('ok');
    return;
  }
  let target;
  try {
    target = new URL(request.url ?? '');
  } catch {
    // Not a proxy request: a client that dialled this port as if it were the origin.
    response.writeHead(400).end('this is a forward proxy: send an absolute address or a CONNECT');
    return;
  }
  const scheme = target.protocol.replace(/:$/, '');
  const from = request.socket.remoteAddress;
  const refused = refusal(request);
  if (refused !== undefined) {
    log({ from, method: request.method, target: target.host, scheme, refused });
    response
      .writeHead(407, { 'Proxy-Authenticate': CHALLENGE, Connection: 'close' })
      .end('proxy authentication required');
    return;
  }
  log({ from, method: request.method, target: target.host, scheme });
  if (scheme !== 'http' && scheme !== 'https') {
    response.writeHead(400).end(`this proxy carries http and https, not ${scheme}`);
    return;
  }
  const headers = { ...request.headers, host: target.host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  // An https address in absolute form is fetched over TLS from here: `http.request` throws on it,
  // which until wave 18 took the proxy, and every service's way out, down with it (W17-R28).
  const upstream = (scheme === 'https' ? httpsRequest : httpRequest)(
    target,
    { method: request.method, headers },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    log({ from, target: target.host, scheme, failed: error.message });
    if (!response.headersSent) response.writeHead(502, { connection: 'close' });
    response.end();
  });
  request.pipe(upstream);
});

server.on('connect', (request, client, head) => {
  const [host, targetPort] = (request.url ?? '').split(':');
  const refused = refusal(request);
  if (refused !== undefined) {
    log({ from: client.remoteAddress, method: 'CONNECT', target: request.url, refused });
    client.end(
      `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${CHALLENGE}\r\n` +
        'Connection: close\r\n\r\n',
    );
    return;
  }
  log({ from: client.remoteAddress, method: 'CONNECT', target: request.url });
  const upstream = connect(Number(targetPort || 443), host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', (error) => {
    log({ from: client.remoteAddress, target: request.url, failed: error.message });
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  client.on('error', () => upstream.destroy());
});

server.listen(port, '0.0.0.0', () =>
  log({ message: 'listening', port, credentials: credentials !== undefined }),
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
