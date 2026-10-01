import { describe, expect, it } from 'vitest';
import {
  claimVerdicts,
  openCheckTicket,
  sealCheckTicket,
  type ClaimCheckInput,
} from '../../../src/lib/sign-in-check';

const SECRET = 't'.repeat(43);
const NOW = 1_790_000_000_000;
const TENANT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const OKTA: ClaimCheckInput = {
  issuer: 'https://acme.okta.com',
  clientId: 'day0-app',
  allowedDomains: ['acme.test'],
  emailTrusted: false,
  refreshTokenGranted: true,
};

function verdictOf(
  claims: Record<string, unknown>,
  input: ClaimCheckInput,
  claim: string,
): string | undefined {
  return claimVerdicts(claims, input).find((one) => one.claim === claim)?.status;
}

const BASE = {
  iss: 'https://acme.okta.com',
  aud: 'day0-app',
  sub: '00u1',
  email: 'priya@acme.test',
  email_verified: true,
  iat: NOW / 1000,
  exp: NOW / 1000 + 3600,
};

describe('the live check’s claim verdicts', (): void => {
  it('passes every claim of a good token, one line each in a fixed order', (): void => {
    const verdicts = claimVerdicts(BASE, OKTA);
    expect(verdicts.map((one) => one.claim)).toEqual([
      'iss',
      'aud',
      'sub',
      'email',
      'email_verified',
      'exp',
      'refresh_token',
    ]);
    expect(verdicts.every((one) => one.status === 'ok')).toBe(true);
    expect(verdicts.find((one) => one.claim === 'exp')?.value).toBe('60 minutes');
  });

  it('tells the operator, not the person, what a refused address means and what to do', (): void => {
    const note = claimVerdicts({ ...BASE, email: 'eve@rival.test' }, OKTA).find(
      (one) => one.claim === 'email',
    )?.note;
    expect(note).toBe(
      'Outside DAY0_OIDC_ALLOWED_DOMAINS (acme.test). Add the domain and run pnpm sync:env, or check with an allowed account.',
    );
    const google = { ...OKTA, issuer: 'https://accounts.google.com' };
    const hd = claimVerdicts({ ...BASE, iss: google.issuer, hd: 'rival.test' }, google).find(
      (one) => one.claim === 'hd',
    )?.note;
    expect(hd).toBe(
      'Not a Google Workspace in DAY0_OIDC_ALLOWED_DOMAINS (acme.test): a personal account, or another organisation’s.',
    );
  });

  it('marks an issuer, an audience or a domain that is not the configured one as a gap', (): void => {
    expect(verdictOf({ ...BASE, iss: 'https://acme.okta.com/' }, OKTA, 'iss')).toBe('gap');
    expect(verdictOf({ ...BASE, aud: ['other'] }, OKTA, 'aud')).toBe('gap');
    expect(verdictOf({ ...BASE, aud: ['other', 'day0-app'] }, OKTA, 'aud')).toBe('ok');
    expect(verdictOf({ ...BASE, email: 'eve@rival.test' }, OKTA, 'email')).toBe('gap');
  });

  it('reads Entra’s xms_edov and tid, and says the address is unverified without either claim', (): void => {
    const entra = { ...OKTA, issuer: ENTRA };
    const token = { ...BASE, iss: ENTRA, tid: TENANT, email_verified: undefined, xms_edov: true };
    expect(verdictOf(token, entra, 'xms_edov')).toBe('ok');
    expect(verdictOf(token, entra, 'tid')).toBe('ok');
    expect(verdictOf({ ...token, tid: 'another-tenant' }, entra, 'tid')).toBe('gap');
    const bare = { ...token, xms_edov: undefined };
    const missing = claimVerdicts(bare, entra).find((one) => one.claim === 'xms_edov');
    expect(missing?.status).toBe('gap');
    expect(missing?.note).toContain('optional claim');
    expect(verdictOf(bare, { ...entra, emailTrusted: true }, 'xms_edov')).toBe('warn');
  });

  it('holds Google to its hd and its refresh token', (): void => {
    const google = { ...OKTA, issuer: 'https://accounts.google.com' };
    const token = { ...BASE, iss: 'https://accounts.google.com', hd: 'acme.test' };
    expect(verdictOf(token, google, 'hd')).toBe('ok');
    expect(verdictOf({ ...token, hd: undefined }, google, 'hd')).toBe('gap');
    const noRefresh = claimVerdicts(token, { ...google, refreshTokenGranted: false }).find(
      (one) => one.claim === 'refresh_token',
    );
    expect(noRefresh?.status).toBe('gap');
    expect(noRefresh?.note).toContain('prompt=consent');
  });
});

describe('the one-time check ticket', (): void => {
  it('opens with the session secret before it expires, and reports only to this machine', async (): Promise<void> => {
    const ticket = {
      checkId: 'c1',
      reportTo: 'http://127.0.0.1:41234/report',
      expiresAt: NOW + 600_000,
    };
    const sealed = await sealCheckTicket(SECRET, ticket);
    expect(await openCheckTicket(SECRET, sealed, NOW)).toEqual(ticket);
    expect(await openCheckTicket('x'.repeat(43), sealed, NOW)).toBeUndefined();
    expect(await openCheckTicket(SECRET, sealed, NOW + 600_000)).toBeUndefined();
    const elsewhere = await sealCheckTicket(SECRET, {
      ...ticket,
      reportTo: 'https://evil.test/report',
    });
    expect(await openCheckTicket(SECRET, elsewhere, NOW)).toBeUndefined();
    // Only the check's own listener: this machine, plain http, the /report path.
    const otherPath = await sealCheckTicket(SECRET, {
      ...ticket,
      reportTo: 'http://127.0.0.1:3550/api/seed',
    });
    expect(await openCheckTicket(SECRET, otherPath, NOW)).toBeUndefined();
  });
});
