/**
 * The fake Linear's compose healthcheck: its `/healthz` on this container's
 * loopback, over https when it serves a certificate and http otherwise. The
 * certificate names Linear's hosts and the fake's address, not loopback, so it
 * is not checked here; the check asks only whether the listener answers.
 */
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

const port = Number(process.env.FAKE_LINEAR_PORT || 443);
const tlsDir = process.env.FAKE_LINEAR_TLS_DIR ?? '';
const secure = tlsDir !== '' && existsSync(join(tlsDir, 'cert.pem'));
const request = secure ? httpsRequest : httpRequest;

const probe = request(
  { host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false, timeout: 4_000 },
  (response) => process.exit(response.statusCode === 200 ? 0 : 1),
);
probe.on('error', () => process.exit(1));
probe.on('timeout', () => {
  probe.destroy();
  process.exit(1);
});
probe.end();
