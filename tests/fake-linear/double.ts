import { createHash, randomBytes } from 'node:crypto';
import { createLinear } from '../../fake-linear/linear.js';
import type { FakeLinear, FakeLinearApp } from '../../fake-linear/linear';
import { WALK_SHARED_APP_USER } from '../fixtures/linear/linear-walks-2026-10-03';

/** The bed's redirect, as the walks registered it on the apps (W-L1, W-L4). */
export const REDIRECT = 'https://127.0.0.1:3580/api/oauth/linear';

/** The organisation's shared app, client credentials on (W-L1), its app user the walks' own id. */
export const SHARED: FakeLinearApp = {
  clientId: 'day0-fake-linear-shared',
  clientSecret: 'day0-fake-linear-shared-secret',
  name: 'Day0',
  clientCredentials: true,
  redirectUris: [REDIRECT],
  appUserId: WALK_SHARED_APP_USER.id,
};

/** An employee's own app, authorisation code only (the re-walk's "Leo (Day0)", W-L4). */
export const LEO: FakeLinearApp = {
  clientId: 'day0-fake-linear-leo',
  clientSecret: 'day0-fake-linear-leo-secret',
  name: 'Leo (Day0)',
  clientCredentials: false,
  redirectUris: [REDIRECT],
};

/** The workspace administrator's personal API key (a fake in the tree's short shape). */
export const SAM_KEY = 'lin_api_day0_fake_sam';

/** A clock the test moves. */
export interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

/** A clock starting at the re-walk's first logged answer, 3 October 2026, 15:09:56Z. */
export function clock(): Clock {
  let at = Date.parse('2026-10-03T15:09:56Z');
  return { now: (): number => at, advance: (ms: number): void => void (at += ms) };
}

/** The double with the two walk apps and its default people. */
export function linear(time: Clock = clock()): FakeLinear {
  return createLinear({ apps: [SHARED, LEO], now: time.now });
}

/** What one call answered: the status, the content type and the parsed body (or the raw text). */
export interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Headers;
  readonly body: unknown;
  readonly text: string;
}

/** Send one request to the double, by path, on the host Day0 names for it. */
export async function call(
  fake: FakeLinear,
  url: string,
  init: { form?: Record<string, string>; bearer?: string; json?: unknown; method?: string } = {},
): Promise<Answer> {
  const headers = new Headers();
  let body: string | undefined;
  if (init.form) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(init.form).toString();
  }
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
  const response = await fake.handle(
    new Request(url, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: an HTML page or an empty body, kept as text.
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    headers: response.headers,
    body: parsed,
    text,
  };
}

/** Ask for a client-credentials token of the shared app with Day0's own form (comma-separated). */
export async function appActorToken(
  fake: FakeLinear,
  scope = 'read,write,app:assignable',
): Promise<string> {
  const answer = await call(fake, 'https://api.linear.app/oauth/token', {
    form: {
      grant_type: 'client_credentials',
      client_id: SHARED.clientId,
      client_secret: SHARED.clientSecret,
      scope,
    },
  });
  return (answer.body as { access_token: string }).access_token;
}

/** `viewer` with a token, as Day0's issuer asks it. */
export async function viewer(fake: FakeLinear, token: string): Promise<Answer> {
  return await call(fake, 'https://api.linear.app/graphql', {
    bearer: token,
    json: { query: '{ viewer { id name app } }' },
  });
}

/** A PKCE pair. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The authorise link Day0 builds for an employee's own app (`linearAuthorisationUrl`). */
export function authoriseUrl(
  app: FakeLinearApp,
  challenge: string,
  extra: Record<string, string | null> = {},
): string {
  const url = new URL('https://linear.app/oauth/authorize');
  const params: Record<string, string | null> = {
    client_id: app.clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'read,write,app:assignable',
    state: 'signed-state',
    actor: 'app',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Consent with the page's one click and return the code the redirect carries. */
export async function consent(
  fake: FakeLinear,
  link: string,
): Promise<{ code: string; location: URL }> {
  const form = Object.fromEntries(new URL(link).searchParams);
  const answer = await call(fake, 'https://linear.app/oauth/authorize', {
    form: { ...form, decision: 'authorize' },
  });
  const location = new URL(answer.headers.get('location') ?? '');
  return { code: location.searchParams.get('code') ?? '', location };
}

/** Install an employee's own app end to end and exchange its code: the pair Day0 holds. */
export async function installPair(
  fake: FakeLinear,
  app: FakeLinearApp = LEO,
): Promise<{ access: string; refresh: string; answer: Answer }> {
  const { verifier, challenge } = pkce();
  const { code } = await consent(fake, authoriseUrl(app, challenge));
  const answer = await call(fake, 'https://api.linear.app/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    },
  });
  const body = answer.body as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token, answer };
}

/** Refresh a pair with Day0's own form. */
export async function refresh(
  fake: FakeLinear,
  token: string,
  app: FakeLinearApp = LEO,
): Promise<Answer> {
  return await call(fake, 'https://api.linear.app/oauth/token', {
    form: {
      grant_type: 'refresh_token',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: token,
    },
  });
}

/** Revoke a token as Day0 does: the form, the hint, no client authentication. */
export async function revoke(
  fake: FakeLinear,
  token: string,
  hint?: 'access_token' | 'refresh_token',
): Promise<Answer> {
  return await call(fake, 'https://api.linear.app/oauth/revoke', {
    form: { token, ...(hint ? { token_type_hint: hint } : {}) },
  });
}
