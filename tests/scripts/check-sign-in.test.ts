import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatSignInReport,
  probeApp,
  reportExitCode,
  signInCheckLink,
  waitForReport,
} from '../../scripts/check-sign-in';
import { openCheckTicket, type SignInCheckReport } from '../../src/lib/sign-in-check';

const REPORT: SignInCheckReport = {
  version: 1,
  checkId: 'check-1',
  checkedAt: 1_790_000_000_000,
  verdicts: [
    {
      claim: 'iss',
      value: 'https://issuer.acme.test',
      status: 'ok',
      note: 'Equal to DAY0_OIDC_ISSUER byte for byte.',
    },
    { claim: 'aud', value: 'day0-app', status: 'ok', note: 'Names the client id.' },
    { claim: 'email', value: 'priya@acme.test', status: 'ok', note: 'In an allowed domain.' },
    {
      claim: 'email_verified',
      value: '(absent)',
      status: 'gap',
      note: 'Ask the issuer to send email_verified.',
    },
  ],
  whoAmI: { status: 'ok', ownerKey: 'https://issuer.acme.test|priya', verifiedAddress: null },
};

describe('pnpm check:sign-in', (): void => {
  it("prints each claim's verdict, then the owner key Convex derived", (): void => {
    const lines = formatSignInReport(REPORT);
    expect(lines).toEqual([
      'pass  iss             https://issuer.acme.test  Equal to DAY0_OIDC_ISSUER byte for byte.',
      'pass  aud             day0-app                  Names the client id.',
      'pass  email           priya@acme.test           In an allowed domain.',
      'GAP   email_verified  (absent)                  Ask the issuer to send email_verified.',
      'pass  whoAmI          https://issuer.acme.test|priya  The deployment accepted the token (no verified address).',
    ]);
    expect(reportExitCode(REPORT)).toBe(1);
    expect(
      reportExitCode({ ...REPORT, verdicts: REPORT.verdicts.filter((one) => one.status === 'ok') }),
    ).toBe(0);
  });

  it('fails when the deployment did not accept the token, whatever the claims say', (): void => {
    const refused: SignInCheckReport = {
      ...REPORT,
      verdicts: REPORT.verdicts.slice(0, 3),
      whoAmI: {
        status: 'gap',
        detail: 'The deployment did not accept the token: Could not verify',
      },
    };
    expect(formatSignInReport(refused).at(-1)).toBe(
      'GAP   whoAmI          The deployment did not accept the token: Could not verify',
    );
    expect(reportExitCode(refused)).toBe(1);
  });

  it('prints a one-time link to the login route carrying a ticket only the session secret opens', async (): Promise<void> => {
    const secret = 'k'.repeat(43);
    const link = await signInCheckLink(
      { publicUrl: 'https://day0.acme.test', sessionSecret: secret },
      {
        checkId: 'check-1',
        reportTo: 'http://127.0.0.1:41000/report',
        expiresAt: Date.now() + 60_000,
      },
    );
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe('https://day0.acme.test/api/auth/oidc/login');
    expect(await openCheckTicket(secret, url.searchParams.get('check') ?? '')).toMatchObject({
      checkId: 'check-1',
    });
  });

  it("waits on this machine for the callback's report, and ignores one for another check", async (): Promise<void> => {
    const waiting = await waitForReport('check-1', 5_000);
    const post = async (body: unknown): Promise<number> =>
      (
        await fetch(waiting.reportTo, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status;
    expect(new URL(waiting.reportTo).hostname).toBe('127.0.0.1');
    expect(await post({ ...REPORT, checkId: 'another' })).toBe(404);
    expect(await post(REPORT)).toBe(204);
    await expect(waiting.report).resolves.toEqual(REPORT);
  });

  it('gives up waiting after its time, saying so', async (): Promise<void> => {
    const waiting = await waitForReport('check-1', 50);
    await expect(waiting.report).rejects.toThrow('No sign-in reached the check');
  });
});

describe('the proxy probes, by the environment they are given (wave 17, 17-P)', (): void => {
  // The probe blocks this process until its child answers, so what it asks is a process of its own.
  let app: ChildProcess;
  let origin = '';

  beforeAll(async (): Promise<void> => {
    app = spawn(process.execPath, [
      '-e',
      "const s=require('node:http').createServer((q,r)=>{r.setHeader('x-day0','app');r.end('ok')})" +
        ".listen(0,'127.0.0.1',()=>console.log(s.address().port))",
    ]);
    const port = await new Promise<string>((resolvePort) => {
      app.stdout?.once('data', (data: Buffer) => resolvePort(String(data).trim()));
    });
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll((): void => {
    app.kill();
  });

  // The setup's own children are handed the proxy with this machine kept out of it; the install's
  // proxy step asked without it, so it and a check run by hand could disagree about one address.
  it('ask through the proxy the environment names, and directly for what NO_PROXY keeps out', (): void => {
    const proxied = {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      HTTP_PROXY: 'http://127.0.0.1:9',
      NODE_USE_ENV_PROXY: '1',
    } as const;
    expect(probeApp(origin, { ...proxied, NO_PROXY: '127.0.0.1' })).toEqual({
      status: 200,
      day0: true,
    });
    // Nothing listens at the proxy's address, so an answer here would mean it was not asked.
    expect(probeApp(origin, { ...proxied, NO_PROXY: 'elsewhere.test' })).toHaveProperty('error');
  });
});
