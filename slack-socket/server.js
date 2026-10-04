import { createServer } from 'node:http';
import { createBridge } from './bridge.js';

/**
 * The `slack-socket` compose service (wave 12, 12-M; RM7): the bridge, and a health check on the
 * compose network that says whether the app list was read and which apps hold a connection. It
 * publishes no port: only the compose healthcheck and `check:access` (through `docker compose
 * exec`) ask it anything.
 */

const secret = (process.env.DAY0_SOCKET_BRIDGE_SECRET ?? '').trim();
const backendUrl = process.env.DAY0_SOCKET_BACKEND_URL || 'http://backend:3211';
const healthPort = Number(process.env.SLACK_SOCKET_HEALTH_PORT || 8080);

function log(line) {
  process.stdout.write(
    `${JSON.stringify({ service: 'slack-socket', at: new Date().toISOString(), ...line })}\n`,
  );
}

if (secret === '') {
  log({
    level: 'error',
    message:
      'DAY0_SOCKET_BRIDGE_SECRET is required by --profile slack-socket; run ./setup.sh (or pnpm dev:no-auth-key) once to generate it',
  });
  process.exit(1);
}

const bridge = createBridge({ backendUrl, secret, log });

const health = createServer((request, response) => {
  if (request.url !== '/healthz') {
    response.writeHead(404).end();
    return;
  }
  const status = bridge.status();
  response.writeHead(status.synced ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify(status));
});

health.listen(healthPort, '0.0.0.0');
await bridge.start();
log({ level: 'info', message: 'started', backendUrl });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bridge.stop();
    health.close(() => process.exit(0));
  });
}
