/**
 * A documentation provider answered in-process from the fixtures beside this file.
 *
 * Each directory here (`confluence-v2`, `confluence-dc`, `sharepoint`, `yuque`, `drive`) holds a
 * `provider.json` naming the published reference its answers were written from and every route
 * the fake answers, and one file a body. **The answers were written from each vendor's
 * published reference, not recorded from a tenant: no vendor host was called** (the operator has
 * named no tenant, RM16). The fake checks what the real API checks that a reader depends on: the
 * token on every route that needs one, the exact query a listing is asked with, and the
 * credentials a token route is given.
 */
import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORY = join(import.meta.dirname, '.');

/** One route: the request it answers and what it answers with. */
export interface FixtureRoute {
  readonly method: string;
  /** The host the request must name, when the provider answers on more than one. */
  readonly host?: string;
  readonly path: string;
  /** The query, pair by pair, in any order; `*` stands for any value. Absent: none. */
  readonly query?: ReadonlyArray<readonly [string, string]>;
  /** A POST's form fields, each exactly; `*` stands for any value. */
  readonly form?: Readonly<Record<string, string>>;
  /** Answered without the provider's token: a token route, or a pre-signed download. */
  readonly open?: boolean;
  /** The `Authorization` this route needs in place of the provider's. */
  readonly authorization?: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** The file beside `provider.json` that is the body, sent as its bytes. */
  readonly body?: string;
}

/** One provider's fixtures. */
export interface ProviderFixture {
  /** Where each answer's shape was read, and when. */
  readonly reference: ReadonlyArray<{ readonly url: string; readonly read: string }>;
  /** The `Authorization` every route needs unless it says otherwise. */
  readonly authorization: string;
  /** The header a provider takes its token in, when it is not `Authorization` (Yuque). */
  readonly tokenHeader?: { readonly name: string; readonly value: string };
  /** What a request without that header is answered. */
  readonly unauthorised: { readonly status: number; readonly body?: string };
  /** What a token route answers a form it does not accept; `unauthorised` when absent. */
  readonly refusedForm?: { readonly status: number; readonly body?: string };
  /** What a request no route answers is answered. */
  readonly notFound: { readonly status: number; readonly body?: string };
  /**
   * A signed assertion a token route checks (Google's service account): the form field that
   * holds the JWT and the claims it must carry. The signature is checked against the test's key.
   */
  readonly assertion?: {
    readonly path: string;
    readonly field: string;
    readonly claims: Readonly<Record<string, string>>;
  };
  readonly routes: readonly FixtureRoute[];
}

/** One request the fake answered, with the clock reading when it arrived. */
export interface FakeRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization?: string;
  /** Every header the request carried. */
  readonly headers: Headers;
  readonly body?: string;
  readonly at: number;
}

/** A response a test puts in place of the fixture's, or undefined to keep it. */
export type FakeOverride = (request: FakeRequest) => Response | undefined;

/** What a test gives the fake. */
export interface ProviderFakeOptions {
  /** The clock requests are stamped with. */
  readonly now?: () => number;
  /** A test's own answer for a request. */
  readonly override?: FakeOverride;
  /** The PEM public key a signed assertion is checked against. */
  readonly publicKey?: string;
}

/** A provider's fixtures, as its `provider.json` describes them. */
export function providerFixture(kind: string): ProviderFixture {
  return JSON.parse(readFileSync(join(DIRECTORY, kind, 'provider.json'), 'utf8')) as ProviderFixture;
}

/** A fixture file's bytes. */
export function fixtureBytes(kind: string, name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(DIRECTORY, kind, name)));
}

/** Whether a route's pairs are exactly the request's, `*` standing for any value. */
function samePairs(
  expected: ReadonlyArray<readonly [string, string]>,
  actual: ReadonlyArray<readonly [string, string]>,
): boolean {
  if (expected.length !== actual.length) return false;
  const left = actual.map(([name, value]) => ({ name, value }));
  // Exact values first, so a wildcard never takes the pair an exact value needs.
  const wanted = [...expected].sort(([, a], [, b]) => Number(a === '*') - Number(b === '*'));
  for (const [name, value] of wanted) {
    const at = left.findIndex(
      (pair) => pair.name === name && (value === '*' || pair.value === value),
    );
    if (at === -1) return false;
    left.splice(at, 1);
  }
  return true;
}

/** Whether a route answers this request. */
function matches(route: FixtureRoute, request: FakeRequest): boolean {
  if (route.method !== request.method || route.path !== request.url.pathname) return false;
  if (route.host !== undefined && route.host !== request.url.host) return false;
  if (!samePairs(route.query ?? [], [...request.url.searchParams.entries()])) return false;
  if (route.form === undefined) return true;
  const form = [...new URLSearchParams(request.body ?? '').entries()];
  return samePairs(Object.entries(route.form), form);
}

/** Whether a signed assertion carries the fixture's claims under the test's key (RS256). */
function assertionHolds(
  assertion: NonNullable<ProviderFixture['assertion']>,
  request: FakeRequest,
  publicKey: string | undefined,
): boolean {
  const jwt = new URLSearchParams(request.body ?? '').get(assertion.field) ?? '';
  const [header, payload, signature] = jwt.split('.');
  if (publicKey === undefined || !header || !payload || !signature) return false;
  const verified = createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, Buffer.from(signature, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  return (
    verified &&
    Object.entries(assertion.claims).every(([name, value]) => claims[name] === value) &&
    typeof claims.exp === 'number' &&
    typeof claims.iat === 'number'
  );
}

/**
 * A fetch that answers from one provider's fixtures.
 *
 * @param kind - The provider's directory beside this file.
 * @param options - The clock, a test's own answers, and the key a signed assertion is checked with.
 * @returns The fetch and the requests it answered, in order.
 */
export function providerFake(
  kind: string,
  options: ProviderFakeOptions = {},
): {
  readonly fetch: (input: URL | string | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: FakeRequest[];
  readonly fixture: ProviderFixture;
} {
  const fixture = providerFixture(kind);
  const requests: FakeRequest[] = [];
  const answer = (status: number, body?: string, headers?: Readonly<Record<string, string>>) =>
    new Response(body === undefined ? null : fixtureBytes(kind, body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
  const fetch = async (input: URL | string | Request, init: RequestInit = {}): Promise<Response> => {
    const request: FakeRequest = {
      method: init.method ?? 'GET',
      url: new URL(input instanceof Request ? input.url : input),
      authorization: new Headers(init.headers).get('authorization') ?? undefined,
      headers: new Headers(init.headers),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      at: options.now?.() ?? 0,
    };
    requests.push(request);
    const replaced = options.override?.(request);
    if (replaced !== undefined) return replaced;
    const route = fixture.routes.find((candidate) => matches(candidate, request));
    if (route === undefined) {
      // A route that exists for another token or form is a refusal, not an absence.
      const known = fixture.routes.some(
        (candidate) =>
          candidate.method === request.method && candidate.path === request.url.pathname,
      );
      const refusal =
        known && request.method === 'POST'
          ? (fixture.refusedForm ?? fixture.unauthorised)
          : fixture.notFound;
      return answer(refusal.status, refusal.body);
    }
    if (
      fixture.assertion !== undefined &&
      fixture.assertion.path === route.path &&
      !assertionHolds(fixture.assertion, request, options.publicKey)
    ) {
      const refusal = fixture.refusedForm ?? fixture.unauthorised;
      return answer(refusal.status, refusal.body);
    }
    const needed = route.authorization ?? fixture.authorization;
    const authorised =
      fixture.tokenHeader === undefined
        ? request.authorization === needed
        : request.headers.get(fixture.tokenHeader.name) === fixture.tokenHeader.value;
    if (route.open !== true && !authorised) {
      return answer(fixture.unauthorised.status, fixture.unauthorised.body);
    }
    return answer(route.status, route.body, route.headers);
  };
  return { fetch, requests, fixture };
}
