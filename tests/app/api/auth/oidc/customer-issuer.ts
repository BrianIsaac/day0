import { vi } from 'vitest';
import { createIssuer, type FakeIssuer, type FakePerson } from '../../../../../fake-oidc/issuer.js';

/**
 * The customer-local sign-in's test bed: the in-tree test issuer answering
 * behind a stubbed `fetch` (the network seam, standard 11.3), and the server
 * environment a customer install would have.
 */

/** The issuer every route test signs in through. */
export const ISSUER = 'https://issuer.acme.test';
/** The client id the app is registered as, and the audience Convex checks. */
export const CLIENT_ID = 'day0-app';
/** A test-only secret in the tree's short shape. */
export const CLIENT_SECRET = 'day0-test-client-secret';
/** The origin people reach the app on. */
export const PUBLIC_URL = 'https://day0.acme.test';
/** 43 characters: the shortest session secret accepted. */
export const SESSION_SECRET = 's'.repeat(43);

/**
 * Set the customer-local environment and route `fetch` to a fresh test issuer.
 *
 * @param options - The people and token lifetime, and any environment to override.
 */
export function customerIssuer(
  options: {
    readonly people?: readonly FakePerson[];
    readonly tokenSeconds?: number;
    readonly issuer?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly now?: () => number;
  } = {},
): FakeIssuer {
  const issuer = createIssuer({
    issuer: options.issuer ?? ISSUER,
    clients: [
      {
        id: CLIENT_ID,
        secret: CLIENT_SECRET,
        redirectUris: [`${PUBLIC_URL}/api/auth/oidc/callback`],
      },
    ],
    ...(options.people ? { people: options.people } : {}),
    ...(options.tokenSeconds ? { tokenSeconds: options.tokenSeconds } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const env: Record<string, string> = {
    NEXT_PUBLIC_DAY0_PROFILE: 'customer-local',
    DAY0_PROFILE: 'customer-local',
    DAY0_OIDC_ISSUER: options.issuer ?? ISSUER,
    DAY0_OIDC_AUDIENCE: CLIENT_ID,
    DAY0_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    DAY0_OIDC_ALLOWED_DOMAINS: 'acme.test',
    DAY0_SESSION_SECRET: SESSION_SECRET,
    DAY0_PUBLIC_URL: PUBLIC_URL,
    ...options.env,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (!request.url.startsWith(issuer.issuer)) {
        throw new Error(`the test reached ${request.url}, which is not the test issuer`);
      }
      return issuer.handle(request);
    },
  );
  return issuer;
}

/** Every cookie a response sets, by name, with its attributes as Next records them. */
export function setCookies(response: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const name = line.slice(0, line.indexOf('='));
    cookies.set(name, line);
  }
  return cookies;
}

/** One cookie's value from a `Set-Cookie` line. */
export function cookieValue(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const pair = line.split(';')[0];
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
}
