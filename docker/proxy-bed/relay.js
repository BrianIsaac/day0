/**
 * A bed's relay (wave 17, 17-P): this machine's loopback ports for the backend, carried to the
 * backend's own address on the bed's network. A bed whose networks have no route out cannot
 * publish a port (Docker publishes none on an internal network), and the setup, the Convex CLI,
 * the app and the reverse proxy all reach the backend at 127.0.0.1 as they do on a customer's
 * machine. Plain TCP, so the live connection's upgrade passes untouched. Only
 * docker/proxy.bed.yml starts it, on the host's network.
 *
 * RELAYS is `listen port=host:port`, separated by commas.
 */
import { connect, createServer } from 'node:net';

const relays = (process.env.RELAYS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '')
  .map((entry) => {
    const [listen, target] = entry.split('=');
    const [host, port] = target.split(':');
    return { listen: Number(listen), host, port: Number(port) };
  });

if (relays.length === 0) {
  process.stderr.write('RELAYS names no relay: <listen port>=<host>:<port>, separated by commas\n');
  process.exit(1);
}

for (const relay of relays) {
  createServer((client) => {
    const upstream = connect(relay.port, relay.host);
    client.pipe(upstream);
    upstream.pipe(client);
    // Either end going away ends the other: nothing here is worth a retry.
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  }).listen(relay.listen, '127.0.0.1', () => {
    process.stdout.write(`127.0.0.1:${relay.listen} -> ${relay.host}:${relay.port}\n`);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
