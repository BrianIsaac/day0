import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserTitleMarker } from '../../src/surfaces/browser';

/**
 * The synthetic system is a real server, so it is tested by running it.
 *
 * What matters about it for the product is narrow: it refuses without the
 * documented login, it has one editable figure, and saving stamps an audit line
 * naming who changed it and when. That line is the evidence the browser floor
 * reads back, so if it ever stopped appearing the floor would have nothing to
 * quote and the demo would be reporting a change it could not see.
 */

const SERVER = fileURLToPath(new URL('../../looker-tile/server.js', import.meta.url));
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'revops';
const PASSWORD = 'pipeline-tile-test';

let child: ChildProcess;

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the looker tile did not start');
}

beforeAll(async (): Promise<void> => {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LOOKER_TILE_PORT: String(PORT),
      LOOKER_TILE_USER: USER,
      LOOKER_TILE_PASSWORD: PASSWORD,
    },
    stdio: 'ignore',
  });
  await waitForReady();
}, 20_000);

afterAll((): void => {
  child?.kill('SIGTERM');
});

/** Sign in and return the session cookie the dashboard needs. */
async function signIn(password = PASSWORD): Promise<Response> {
  return await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USER, password }).toString(),
    redirect: 'manual',
  });
}

function cookieOf(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0];
}

describe('the Looker pipeline tile', (): void => {
  it('shows the sign-in form to an anonymous visitor', async (): Promise<void> => {
    const body = await (await fetch(BASE)).text();
    expect(body).toContain('Sign in');
    expect(body).toContain('name="password"');
    expect(body).not.toContain('Pipeline coverage');
  });

  it('matches the documented probe marker before a login exists', async (): Promise<void> => {
    const body = await (await fetch(BASE)).text();
    const title = /<title>([^<]+)<\/title>/.exec(body)?.[1];
    const runbook = readFileSync(
      new URL('../fixtures/notion-pages/looker-pipeline-tile.md', import.meta.url),
      'utf8',
    );
    expect(browserTitleMarker(runbook)).toBe(title);
  });

  it('says plainly on the page that it has no integration surface', async (): Promise<void> => {
    const body = await (await fetch(BASE)).text();
    expect(body).toContain('No API or integration surface is available.');
  });

  it('refuses a wrong password without a session', async (): Promise<void> => {
    const response = await signIn('not-the-password');
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('do not match');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('opens the dashboard on the documented login', async (): Promise<void> => {
    const response = await signIn();
    expect(response.status).toBe(200);
    expect(cookieOf(response)).toMatch(/^looker_session=/);
    const body = await response.text();
    expect(body).toContain('Pipeline coverage');
    expect(body).toContain('name="coverage"');
    expect(body).toContain('Save');
  });

  it('refuses to save without a session', async (): Promise<void> => {
    const response = await fetch(`${BASE}/tile`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ coverage: '99%' }).toString(),
    });
    expect(response.status).toBe(401);
  });

  it('saves the figure and stamps the audit line the runbook reads back', async (): Promise<void> => {
    const cookie = cookieOf(await signIn());
    const before = await (await fetch(BASE, { headers: { cookie } })).text();
    expect(before).toContain('Never updated since this instance started.');

    const saved = await fetch(`${BASE}/tile`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ coverage: '74%' }).toString(),
    });
    const body = await saved.text();
    expect(saved.status).toBe(200);
    expect(body).toContain('74%');
    expect(body).toContain('Saved.');
    expect(body).toMatch(/Last updated by revops at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  });

  it('keeps the saved figure for the next visitor', async (): Promise<void> => {
    const cookie = cookieOf(await signIn());
    const body = await (await fetch(BASE, { headers: { cookie } })).text();
    expect(body).toContain('74%');
    expect(body).toContain('Last updated by revops');
  });

  it('escapes a figure rather than rendering it as markup', async (): Promise<void> => {
    const cookie = cookieOf(await signIn());
    await fetch(`${BASE}/tile`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ coverage: '<img src=x onerror=1>' }).toString(),
    });
    const body = await (await fetch(BASE, { headers: { cookie } })).text();
    expect(body).toContain('&lt;img src=x onerror=1&gt;');
    expect(body).not.toContain('<img src=x');
  });
});
