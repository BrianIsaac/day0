import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/*
 * The proxy bed's overlay and its two small services (wave 17, 17-P; decision P-2): the forward
 * proxy that is a bed's only route out, and the relay that carries this machine's loopback ports
 * to a backend whose network publishes none. Each is started as the overlay starts it.
 */

const path = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url));

interface Service {
  readonly profiles?: readonly string[];
  readonly image?: string;
  readonly network_mode?: string;
  readonly ports?: readonly string[];
  readonly networks?: Record<string, unknown> | readonly string[];
  readonly environment?: readonly string[];
  readonly volumes?: readonly string[];
}

const OVERLAY = parse(readFileSync(path('docker/proxy.bed.yml'), 'utf8')) as {
  networks: Record<string, { internal?: boolean } | null>;
  services: Record<string, Service>;
};
const COMPOSE = parse(readFileSync(path('docker-compose.yml'), 'utf8')) as {
  networks: Record<string, { internal?: boolean } | null>;
  services: Record<string, Service>;
};

describe("the proxy bed's overlay", (): void => {
  it('leaves no network with a route out but the forward proxy’s own', (): void => {
    const merged: Record<string, { internal?: boolean } | null> = {
      ...COMPOSE.networks,
      default: null,
      ...OVERLAY.networks,
    };
    const open = Object.entries(merged)
      .filter(([, network]) => network?.internal !== true)
      .map(([name]) => name);
    expect(open).toEqual(['proxy-egress']);
    const joined = (name: string): string[] =>
      Object.entries(OVERLAY.services)
        .filter(([, service]) =>
          (Array.isArray(service.networks)
            ? service.networks
            : Object.keys(service.networks ?? {})
          ).includes(name),
        )
        .map(([service]) => service);
    expect(joined('proxy-egress')).toEqual(['forward-proxy']);
    // One address for everything, as a customer's proxy is: the two services the main file keeps
    // off the project network join it here, and gain no way out by it.
    expect(Object.keys(OVERLAY.services['forward-proxy']?.networks ?? {}).sort()).toEqual([
      'default',
      'proxy-egress',
    ]);
    expect(OVERLAY.services['slack-socket']?.networks).toEqual(['default']);
    expect(OVERLAY.services['nango-server']?.networks).toEqual(['default']);
  });

  it('runs each reverse proxy on the host’s network under a profile of its own, its image pinned to a digest', (): void => {
    for (const [name, profile] of [
      ['reverse-proxy-caddy', 'caddy'],
      ['reverse-proxy-nginx', 'nginx'],
    ] as const) {
      const service = OVERLAY.services[name];
      expect(service?.profiles, name).toEqual([profile]);
      expect(service?.network_mode, name).toBe('host');
      expect(service?.image, name).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(service?.ports, name).toBeUndefined();
    }
  });

  it('keeps the image’s own port-80 site out of the host-network nginx', (): void => {
    expect(OVERLAY.services['reverse-proxy-nginx']?.volumes).toContain(
      '/dev/null:/etc/nginx/conf.d/default.conf:ro',
    );
  });

  it('carries this machine’s two backend ports to the backend’s own address, since an internal network publishes none', (): void => {
    const relay = OVERLAY.services['host-relay'];
    expect(relay?.network_mode).toBe('host');
    expect(relay?.environment).toEqual([
      'RELAYS=${CONVEX_PORT:-3210}=${PROXY_BED_BACKEND_ADDRESS:?}:3210,${CONVEX_SITE_PROXY_PORT:-3211}=${PROXY_BED_BACKEND_ADDRESS:?}:3211${PROXY_BED_EXTRA_RELAYS:+,${PROXY_BED_EXTRA_RELAYS}}',
    ]);
  });

  it('is started by no setup verb and named by no script: a bed applies it by hand (P-2)', (): void => {
    const scripts = (directory: string): string[] =>
      readdirSync(path(directory), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? scripts(`${directory}/${entry.name}`)
          : [`${directory}/${entry.name}`],
      );
    const naming = [...scripts('scripts'), 'setup.sh', 'package.json'].filter((file) =>
      /proxy\.bed|proxy-bed/.test(readFileSync(path(file), 'utf8')),
    );
    expect(naming).toEqual([]);
  });

  it('forwards the app’s origin to the app and the backend’s to the backend, in both configurations', (): void => {
    const caddy = readFileSync(path('docker/proxy-bed/Caddyfile'), 'utf8');
    const [caddyApp, caddyBackend] = caddy.split(/^https:\/\//m).slice(1);
    expect(caddyApp).toContain('{$PROXY_BED_APP_PORT} {');
    expect(caddyApp).toContain('reverse_proxy 127.0.0.1:{$DAY0_APP_PORT}');
    expect(caddyApp).toContain('flush_interval -1');
    expect(caddyBackend).toContain('{$PROXY_BED_BACKEND_PORT} {');
    expect(caddyBackend).toContain('reverse_proxy 127.0.0.1:{$CONVEX_PORT}');
    const nginx = readFileSync(path('docker/proxy-bed/nginx.conf.template'), 'utf8');
    const [app, backend] = nginx.split(/^server \{$/m).slice(1);
    expect(app).toContain('proxy_pass http://127.0.0.1:${DAY0_APP_PORT};');
    expect(app).not.toContain('proxy_buffering off');
    expect(backend).toContain('proxy_pass http://127.0.0.1:${CONVEX_PORT};');
    expect(backend).toContain('proxy_set_header Upgrade    $http_upgrade;');
    expect(backend).toContain('proxy_set_header Connection $connection_upgrade;');
  });
});

const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async (): Promise<void> => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', (): void => {
      const { port } = probe.address() as AddressInfo;
      probe.close((): void => resolve(port));
    });
  });
}

/** An origin that answers every request with its own name. */
async function origin(): Promise<number> {
  const server = createServer((request, response): void => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`origin saw ${request.method} ${request.url}`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Start one of the bed's services and wait for the line that says it is listening. */
async function start(script: string, env: Readonly<Record<string, string>>): Promise<string[]> {
  const lines: string[] = [];
  const settings: Record<string, string | undefined> = { PATH: process.env.PATH, ...env };
  const child = spawn(process.execPath, [path(script)], {
    env: settings as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk: Buffer): void => {
    lines.push(
      ...String(chunk)
        .split('\n')
        .filter((line) => line !== ''),
    );
  });
  for (let attempt = 0; attempt < 200 && lines.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (lines.length === 0) throw new Error(`${script} printed nothing`);
  return lines;
}

/** One request written by hand, as a proxy's client writes it, and everything that came back. */
async function exchange(port: number, text: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    let answer = '';
    const socket = connect(port, '127.0.0.1', (): void => void socket.write(text));
    socket.on('data', (chunk): void => {
      answer += String(chunk);
      if (answer.includes('origin saw')) socket.end();
    });
    socket.on('close', (): void => resolve(answer));
    socket.on('error', reject);
  });
}

describe("the bed's forward proxy", (): void => {
  it('tunnels a CONNECT and forwards a plain request, and says who asked for what', async (): Promise<void> => {
    const target = await origin();
    const port = await freePort();
    const lines = await start('docker/proxy-bed/forward-proxy.js', {
      FORWARD_PROXY_PORT: String(port),
    });

    const tunnelled = await exchange(
      port,
      `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n` +
        `GET /through-a-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`,
    );
    expect(tunnelled).toContain('200 Connection Established');
    expect(tunnelled).toContain('origin saw GET /through-a-tunnel');

    // A client that dials the port as if it were the origin is told what this is.
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(400);

    const forwarded = await exchange(
      port,
      `GET http://127.0.0.1:${target}/plain HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`,
    );
    expect(forwarded).toContain('origin saw GET /plain');

    const said = lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(said).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'CONNECT', target: `127.0.0.1:${target}` }),
        expect.objectContaining({ method: 'GET', target: `127.0.0.1:${target}` }),
      ]),
    );
    expect(said.every((line) => typeof line.at === 'string')).toBe(true);
  }, 20_000);
});

// W17-R28 (reader 5): an absolute-form `GET https://...` reached `http.request` with an https URL,
// which throws, and the proxy died with every service's only route out.
describe("the bed's forward proxy, asked in absolute form for an https address", (): void => {
  it('answers it, a bad gateway where the origin speaks no TLS, and keeps serving', async (): Promise<void> => {
    const target = await origin();
    const port = await freePort();
    const lines = await start('docker/proxy-bed/forward-proxy.js', {
      FORWARD_PROXY_PORT: String(port),
    });
    const answered = await exchange(
      port,
      `GET https://127.0.0.1:${target}/secure HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`,
    );
    expect(answered).toMatch(/^HTTP\/1\.1 502 /);
    const after = await exchange(
      port,
      `GET http://127.0.0.1:${target}/after HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`,
    );
    expect(after).toContain('origin saw GET /after');
    const said = lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(said).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', target: `127.0.0.1:${target}`, scheme: 'https' }),
      ]),
    );
  }, 20_000);
});

// The bed's authenticating proxy (the 18-P bed's row): with FORWARD_PROXY_AUTH set, a request
// without the credentials is refused with 407 and one with them is carried, both ways it asks.
describe("the bed's forward proxy, asking for credentials", (): void => {
  it('refuses a client without them, carries one with them, and never logs them', async (): Promise<void> => {
    const target = await origin();
    const port = await freePort();
    const lines = await start('docker/proxy-bed/forward-proxy.js', {
      FORWARD_PROXY_PORT: String(port),
      FORWARD_PROXY_AUTH: 'day0:bed-secret',
    });
    const header = `Proxy-Authorization: Basic ${Buffer.from('day0:bed-secret').toString('base64')}\r\n`;
    const plain = (auth: string): Promise<string> =>
      exchange(
        port,
        `GET http://127.0.0.1:${target}/plain HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n${auth}Connection: close\r\n\r\n`,
      );
    const refused = await plain('');
    expect(refused).toMatch(/^HTTP\/1\.1 407 /);
    expect(refused).toContain('Proxy-Authenticate: Basic realm="day0-bed"');
    expect(await plain(header)).toContain('origin saw GET /plain');
    const tunnel = (auth: string): Promise<string> =>
      exchange(
        port,
        `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n${auth}\r\n` +
          `GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`,
      );
    expect(await tunnel('')).toMatch(/^HTTP\/1\.1 407 /);
    expect(await tunnel(header)).toContain('origin saw GET /tunnel');
    expect(lines.join('\n')).not.toContain('bed-secret');
    expect(lines.join('\n')).toContain('"refused":"no credentials"');
  }, 20_000);
});

describe("the bed's relay", (): void => {
  it('carries a loopback port to the address it is given, both ways', async (): Promise<void> => {
    const target = await origin();
    const port = await freePort();
    const lines = await start('docker/proxy-bed/relay.js', {
      RELAYS: `${port}=127.0.0.1:${target}`,
    });
    expect(lines[0]).toBe(`127.0.0.1:${port} -> 127.0.0.1:${target}`);
    expect(await (await fetch(`http://127.0.0.1:${port}/version`)).text()).toBe(
      'origin saw GET /version',
    );
  }, 20_000);
});

describe('docs/running/proxy.md', (): void => {
  const PAGE = readFileSync(path('docs/running/proxy.md'), 'utf8');

  /** A configuration's lines that do something: no comment, no blank, one space between words. */
  function directives(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter((line) => line !== '' && !line.startsWith('#'));
  }

  /** The page's one fenced block in a language. */
  function printed(language: string): string {
    const block = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``).exec(PAGE);
    expect(block, `a ${language} block`).not.toBeNull();
    return block?.[1] ?? '';
  }

  // "Run on the same bed before it is printed": what the page prints is the file the bed ran,
  // with a customer's names where the bed read its own from its environment.
  it('prints the Caddy configuration the bed ran, with a customer’s names for the bed’s', (): void => {
    // The bed's own: a throwaway certificate's two global options, in a block that is then empty,
    // and an address to bind.
    const own = directives(readFileSync(path('docker/proxy-bed/Caddyfile'), 'utf8')).filter(
      (line) => !['auto_https off', 'admin off'].includes(line) && !/^bind /.test(line),
    );
    expect(own.slice(0, 2)).toEqual(['{', '}']);
    const bed = own
      .slice(2)
      .map((line) =>
        line
          .replace('{$PROXY_BED_ADDRESS}:{$PROXY_BED_APP_PORT}', 'day0.acme.com')
          .replace('{$PROXY_BED_ADDRESS}:{$PROXY_BED_BACKEND_PORT}', 'convex.day0.acme.com')
          .replace('{$DAY0_APP_PORT}', '3000')
          .replace('{$CONVEX_PORT}', '3210')
          .replaceAll('/tls/', '/etc/day0/tls/'),
      );
    expect(directives(printed('caddyfile'))).toEqual(bed);
  });

  it('prints the nginx configuration the bed ran, its two servers told apart by name', (): void => {
    const bed = directives(readFileSync(path('docker/proxy-bed/nginx.conf.template'), 'utf8'))
      .flatMap((line) =>
        line === 'listen ${PROXY_BED_ADDRESS}:${PROXY_BED_APP_PORT} ssl;'
          ? ['listen 443 ssl;', 'server_name day0.acme.com;']
          : line === 'listen ${PROXY_BED_ADDRESS}:${PROXY_BED_BACKEND_PORT} ssl;'
            ? ['listen 443 ssl;', 'server_name convex.day0.acme.com;']
            : [line],
      )
      .map((line) =>
        line
          .replace('${DAY0_APP_PORT}', '3000')
          .replace('${CONVEX_PORT}', '3210')
          .replace('/tls/', '/etc/day0/tls/'),
      );
    expect(directives(printed('nginx'))).toEqual(bed);
    // Its `map` is read inside `http` and nowhere else, so the page says where the file goes.
    expect(PAGE).toContain('under `/etc/nginx/conf.d/`');
  });
});
