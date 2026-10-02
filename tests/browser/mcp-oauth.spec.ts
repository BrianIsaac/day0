import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  authorisationUrl,
  discoverAuthorisation,
  pkceChallenge,
  type McpAuthorisationTarget,
  type OauthFetch,
} from '../../src/surfaces/mcp-oauth';

/*
 * The MCP rung's authorisation driven in a headless browser (wave 11, 11-AM): the test issuer as
 * the authorisation server and the protected MCP resource, the person's consent on its page, and
 * the redirect into Day0's own `app/api/oauth/mcp` route on a second `next start` of the job's
 * build. Only the card's manager, signed in, completes an authorisation (the wave 11 review's M2,
 * decision 3 (a)), so the route is off the sign-in's public list and this job, which holds no
 * session, meets the proxy's refusal there: no deployment is asked and no code is exchanged. The
 * completion itself is `tests/app/api/oauth/mcp/route.test.ts` and
 * `tests/convex/mcpOauthActions.test.ts`, and the signed-in walk is the bed's.
 */

const FAKE_OIDC = fileURLToPath(new URL('../../fake-oidc/server.js', import.meta.url));
const NEXT_BIN = fileURLToPath(new URL('../../node_modules/next/dist/bin/next', import.meta.url));

interface Started {
  readonly state: string;
  readonly verifier: string;
  readonly target: McpAuthorisationTarget;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', (): void => {
      const { port } = probe.address() as AddressInfo;
      probe.close((): void => resolve(port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${url} exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not start`);
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const plainFetch: OauthFetch = async (url, init) => await fetch(url, init);

let issuerBase = '';
let dayZeroBase = '';
let issuer: ChildProcess | undefined;
let dayZero: ChildProcess | undefined;
let convex: Server | undefined;
const pending = new Map<string, Started>();
/** Every call the app's server made to the fake deployment. */
const convexCalls: string[] = [];

/** The deployment, faked: it records every call the app's server makes to it, and answers none. */
async function serveConvex(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse((await bodyOf(request)) || '{}') as { path?: string };
  convexCalls.push(`${request.url ?? ''} ${body.path ?? ''}`);
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
}

/** The card's start, as `startAuthorisation` makes it: discovery, PKCE and the URL. */
async function startAuthorisation(): Promise<string> {
  const target = await discoverAuthorisation(plainFetch, new URL(`${issuerBase}/mcp`), {
    allowInsecure: true,
  });
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  pending.set(state, { state, verifier, target });
  return authorisationUrl({
    server: target.server,
    clientId: 'day0-mcp',
    redirectUrl: `${dayZeroBase}/api/oauth/mcp`,
    state,
    challenge: pkceChallenge(verifier),
    resource: target.resource,
    scopes: target.scopes,
  }).href;
}

async function adminState(): Promise<Record<string, unknown>> {
  return (await (await fetch(`${issuerBase}/admin/state`)).json()) as Record<string, unknown>;
}

test.describe.configure({ mode: 'serial' });

test.describe('the MCP authorisation, walked in the browser', () => {
  test.beforeAll(async ({}, testInfo): Promise<void> => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'one walk: the pages are the test issuer’s and the redirect has no layout of its own',
    );
    const [issuerPort, convexPort, dayZeroPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    issuerBase = `http://127.0.0.1:${issuerPort}`;
    dayZeroBase = `http://127.0.0.1:${dayZeroPort}`;
    issuer = spawn(process.execPath, [FAKE_OIDC], {
      env: {
        ...process.env,
        FAKE_OIDC_ISSUER: issuerBase,
        FAKE_OIDC_PORT: String(issuerPort),
        FAKE_OIDC_REDIRECT_URIS: `${dayZeroBase}/api/auth/oidc/callback`,
        FAKE_OIDC_MCP_PATH: '/mcp',
        FAKE_OIDC_MCP_SCOPES: 'read write',
        FAKE_OIDC_MCP_CLIENT_ID: 'day0-mcp',
        FAKE_OIDC_MCP_REDIRECT_URIS: `${dayZeroBase}/api/oauth/mcp`,
      },
      stdio: 'ignore',
    });
    convex = createServer((request, response) => {
      serveConvex(request, response).catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => convex?.listen(convexPort, '127.0.0.1', resolve));
    dayZero = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(dayZeroPort)], {
      env: {
        ...process.env,
        CONVEX_URL: `http://127.0.0.1:${convexPort}`,
        DAY0_PUBLIC_URL: dayZeroBase,
      },
      stdio: 'ignore',
    });
    await waitFor(`${issuerBase}/healthz`, issuer);
    await waitFor(`${dayZeroBase}/setup`, dayZero);
  });

  test.afterAll(async (): Promise<void> => {
    issuer?.kill('SIGTERM');
    dayZero?.kill('SIGTERM');
    await new Promise<void>((resolve) => (convex ? convex.close(() => resolve()) : resolve()));
  });

  test("holds the redirect to a signed-in session: a consent in a browser with no Day0 session reaches no deployment and exchanges no code (the wave 11 review's M2, decision 3 (a))", async ({
    page,
  }) => {
    await page.goto(await startAuthorisation());
    await expect(page.getByRole('heading', { name: 'Test issuer' })).toBeVisible();
    const redirected = page.waitForResponse((candidate) =>
      candidate.url().startsWith(`${dayZeroBase}/api/oauth/mcp`),
    );
    await page.getByRole('button', { name: /Priya Raman/ }).click();

    expect((await redirected).status()).toBe(401);
    expect(convexCalls).toEqual([]);
    expect(await adminState()).toMatchObject({ codeExchanges: 0 });
  });
});
