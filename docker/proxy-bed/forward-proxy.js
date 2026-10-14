/**
 * A bed's forward proxy (wave 17, 17-P; RM31 (a)): the one route out of a bed whose networks have
 * none of their own, standing in for the HTTP proxy a customer's network puts between Day0 and
 * the internet. It tunnels a CONNECT (https, and the Slack socket's wss) and forwards a plain
 * request, and prints one line for each naming who asked and for what, which is the bed's
 * evidence of what took the proxy. Never a production proxy: it asks for no credentials and
 * carries anything anywhere. Only docker/proxy.bed.yml starts it.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const port = Number(process.env.FORWARD_PROXY_PORT || 3128);

function log(line) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
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
  log({ from: request.socket.remoteAddress, method: request.method, target: target.host });
  const upstream = httpRequest(
    target,
    { method: request.method, headers: { ...request.headers, host: target.host } },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    log({ from: request.socket.remoteAddress, target: target.host, failed: error.message });
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
});

server.on('connect', (request, client, head) => {
  const [host, targetPort] = (request.url ?? '').split(':');
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

server.listen(port, '0.0.0.0', () => log({ message: 'listening', port }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
