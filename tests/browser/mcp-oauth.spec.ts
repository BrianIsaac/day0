import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  authorisationUrl,
  checkResponseIssuer,
  discoverAuthorisation,
  pkceChallenge,
  requestTokens,
  type McpAuthorisationTarget,
  type OauthFetch,
} from '../../src/surfaces/mcp-oauth';

/*
 * The MCP rung's authorisation driven end to end in a headless browser (wave 11, 11-AM): the
 * test issuer as the authorisation server and the protected MCP resource, the person's consent on
 * its page, the redirect into Day0's own `app/api/oauth/mcp` route on a second `next start` of the
 * job's build, and the completion the route asks the deployment for. The browser job holds no
 * backend (playwright.config.ts), so the deployment is a fake Convex endpoint that completes the
 * authorisation with the real client in `src/surfaces/mcp-oauth.ts`; the Convex half itself is
 * `tests/convex/mcpOauthActions.test.ts` and the bed walk.
 */

const FAKE_OIDC = fileURLToPath(new URL('../../fake-oidc/server.js', import.meta.url));
const NEXT_BIN = fileURLToPath(new URL('../../node_modules/next/dist/bin/next', import.meta.url));
const AGENT = 'e2eagent';
const SLUG = 'docs';

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
const answered: { whoami?: string; args?: Record<string, string> } = {};

/** The deployment's half, faked: what `mcpOauthActions.completeAuthorisation` decides, by the real client. */
async function completeAuthorisation(args: Record<string, string>): Promise<unknown> {
  answered.args = args;
  const started = pending.get(args.state ?? '');
  pending.delete(args.state ?? '');
  if (!started) return { ok: false, reason: 'That authorisation has already been used.' };
  const card = { agentId: AGENT, surfaceSlug: SLUG };
  const issuerCheck = checkResponseIssuer({
    iss: args.iss ?? null,
    recordedIssuer: started.target.server.issuer,
    issParameterSupported: started.target.server.issParameterSupported,
  });
  if (!issuerCheck.ok) {
    return { ok: false, reason: 'The response came from another authorisation server.', ...card };
  }
  if (args.error !== undefined) {
    return { ok: false, reason: 'The authorisation was declined.', ...card };
  }
  const tokens = await requestTokens(
    plainFetch,
    {
      tokenEndpoint: started.target.server.tokenEndpoint,
      clientId: 'day0-mcp',
      auth: { method: 'none' },
      resource: started.target.resource,
      grant: {
        grant: 'authorization_code',
        code: args.code ?? '',
        redirectUrl: `${dayZeroBase}/api/oauth/mcp`,
        verifier: started.verifier,
      },
    },
    Date.now(),
  );
  const called = (await (
    await fetch(started.target.resource, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    })
  ).json()) as { result: { content: { text: string }[] } };
  answered.whoami = called.result.content[0]?.text;
  return { ok: true, ...card };
}

async function serveConvex(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse(await bodyOf(request)) as {
    path: string;
    args: Record<string, string>[];
  };
  const value =
    request.url === '/api/action' && body.path === 'mcpOauthActions:completeAuthorisation'
      ? await completeAuthorisation(body.args[0] ?? {})
      : undefined;
  response.writeHead(value === undefined ? 404 : 200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify(value === undefined ? {} : { status: 'success', value, logLines: [] }),
  );
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

/**
 * Where the redirect route sent the browser (its `Location`, with the fragment a request never
 * carries), once the browser has asked for that card. The card itself needs a backend the job
 * does not hold, so it goes on to the sign-in and is not waited for.
 */
async function cardRequest(page: Page): Promise<URL> {
  const [redirected] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url().startsWith(`${dayZeroBase}/api/oauth/mcp`)),
    page.waitForRequest((candidate) => candidate.url().startsWith(`${dayZeroBase}/agent/`)),
  ]);
  expect(redirected.status()).toBe(307);
  return new URL(redirected.headers().location ?? '', dayZeroBase);
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

  test('a manager consents and lands back on the card, authorised as the person they chose', async ({
    page,
  }) => {
    await page.goto(await startAuthorisation());
    await expect(page.getByRole('heading', { name: 'Test issuer' })).toBeVisible();
    const landing = cardRequest(page);
    await page.getByRole('button', { name: /Priya Raman/ }).click();

    const landed = await landing;
    expect(landed.searchParams.get('authorisation')).toBe('authorised');
    expect(landed.searchParams.get('surface')).toBe(SLUG);
    expect(landed.hash).toBe('#surfaces');
    expect(answered.whoami).toBe('priya@acme.test');
    expect(await adminState()).toMatchObject({
      codeExchanges: 1,
      lastResource: `${issuerBase}/mcp`,
    });
  });

  test('a response naming another issuer lands as failed and its code is never exchanged', async ({
    page,
  }) => {
    const exchangesBefore = (await adminState()).codeExchanges;
    let landed: URL;
    await fetch(`${issuerBase}/admin/iss?value=https://rogue.acme.test`, { method: 'POST' });
    try {
      await page.goto(await startAuthorisation());
      const landing = cardRequest(page);
      await page.getByRole('button', { name: /Mateo Silva/ }).click();
      landed = await landing;
    } finally {
      await fetch(`${issuerBase}/admin/iss?value=`, { method: 'POST' });
    }
    expect(landed.searchParams.get('authorisation')).toBe('failed');
    expect(landed.searchParams.get('reason')).toContain('another authorisation server');
    expect((await adminState()).codeExchanges).toBe(exchangesBefore);
  });

  test('a decline lands as failed, the server’s description never handed on', async ({ page }) => {
    await page.goto(await startAuthorisation());
    const landing = cardRequest(page);
    await page.getByRole('button', { name: 'Decline' }).click();
    const landed = await landing;
    expect(landed.searchParams.get('authorisation')).toBe('failed');
    expect(landed.searchParams.get('reason')).toBe('The authorisation was declined.');
    // What the route handed the deployment: the error code and the iss, never the description.
    expect(Object.keys(answered.args ?? {}).sort()).toEqual(['error', 'iss', 'state']);
    expect(answered.args?.error).toBe('access_denied');
  });
});
