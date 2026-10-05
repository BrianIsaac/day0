import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATED_SIGN_IN_MODES,
  NO_SESSION_ROUTES,
  type NoSessionRoute,
  type RouteVerb,
} from '../../../src/lib/anonymous-access';

/**
 * The anonymous-caller sweep over the HTTP routes (wave 12, 12-G): every route file under
 * `app/api/`, read from the tree so a route added later is swept without an edit. In each gated
 * sign-in mode a request with no session reaches exactly the handlers `src/lib/anonymous-access.ts`
 * names; every other handler refuses such a request itself, with no session and no sign-in
 * configured at all, before it asks the deployment anything; and every named route has its own
 * test of what such a request gets.
 */

const ROOT = resolve(__dirname, '../../..');
const APP = 'http://localhost:3000';

/** A signed-out caller, as Clerk's own `auth` argument and its server helper present one. */
const signedOut = Object.assign(
  async (): Promise<{ userId: null; getToken: () => Promise<null> }> => ({
    userId: null,
    getToken: async (): Promise<null> => null,
  }),
  {
    protect: async (): Promise<never> => {
      throw new Error('clerk would redirect to sign-in');
    },
  },
);

vi.mock('@clerk/nextjs/server', () => ({
  auth: signedOut,
  clerkMiddleware:
    (handler: (auth: unknown, request: unknown) => unknown) =>
    (request: unknown): unknown =>
      handler(signedOut, request),
  createRouteMatcher:
    (patterns: string[]) =>
    (request: { nextUrl: URL }): boolean =>
      patterns.some((pattern: string): boolean =>
        new RegExp(`^${pattern.replace('(.*)', '.*')}$`).test(request.nextUrl.pathname),
      ),
}));

vi.mock('next/headers', () => ({
  cookies: async (): Promise<{ get: () => undefined }> => ({ get: (): undefined => undefined }),
  headers: async (): Promise<Headers> => new Headers(),
}));

/** Every request a handler makes of the deployment, which a refused request must never make. */
const asked = vi.hoisted((): string[] => []);

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    constructor(address: string) {
      asked.push(`client ${address}`);
    }
    setAuth(): void {
      asked.push('setAuth');
    }
    async query(): Promise<never> {
      asked.push('query');
      throw new Error('a refused request reached the deployment');
    }
    async mutation(): Promise<never> {
      asked.push('mutation');
      throw new Error('a refused request reached the deployment');
    }
    async action(): Promise<never> {
      asked.push('action');
      throw new Error('a refused request reached the deployment');
    }
  },
}));

/** One exported verb of one route file. */
interface RouteVerbFile {
  readonly path: string;
  readonly verb: RouteVerb;
  readonly file: string;
}

/** Every exported verb of every `route.ts` under `app/api/`. */
function routeVerbs(): RouteVerbFile[] {
  const found: RouteVerbFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') {
        const text = readFileSync(full, 'utf8');
        const path = `/${relative(join(ROOT, 'app'), dirname(full)).split('\\').join('/')}`;
        for (const match of text.matchAll(
          /^export (?:async function|function|const) (GET|POST|PUT|PATCH|DELETE)\b/gm,
        )) {
          found.push({ path, verb: match[1] as RouteVerb, file: relative(ROOT, full) });
        }
      }
    }
  };
  walk(join(ROOT, 'app', 'api'));
  return found.sort((left, right) =>
    `${left.path} ${left.verb}`.localeCompare(`${right.path} ${right.verb}`),
  );
}

const ROUTES = routeVerbs();

function named(route: { path: string; verb: RouteVerb }): NoSessionRoute | undefined {
  return NO_SESSION_ROUTES.find((entry) => entry.path === route.path && entry.verb === route.verb);
}

/** The env of a deployment signed in to each way. */
async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
}

async function useSignInMode(
  mode: (typeof GATED_SIGN_IN_MODES)[number] | 'no-sign-in',
): Promise<void> {
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210');
  vi.stubEnv('DAY0_PUBLIC_URL', APP);
  switch (mode) {
    case 'clerk':
      vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_ZmFrZQ');
      break;
    case 'no-sign-in':
      vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
      break;
    case 'local-key':
      vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('DEV_NO_AUTH_SECRET', 'a'.repeat(43));
      vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', await signingKey());
      break;
    case 'company':
      vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-local');
      vi.stubEnv('DAY0_PROFILE', 'customer-local');
      vi.stubEnv('DAY0_SESSION_SECRET', 'p'.repeat(43));
      break;
    default: {
      const unknown: never = mode;
      throw new Error(`unhandled mode ${String(unknown)}`);
    }
  }
  vi.resetModules();
}

/** A request with no session and no secret, from the app's own page where a route asks that. */
function noSessionRequest(route: { path: string; verb: RouteVerb }): NextRequest {
  return new NextRequest(`${APP}${route.path}`, {
    method: route.verb,
    headers: { origin: APP, 'content-type': 'application/json', host: 'localhost:3000' },
    ...(route.verb === 'GET' ? {} : { body: '{}' }),
  });
}

/** Whether the proxy let a request through to its handler. */
async function reachesHandler(route: { path: string; verb: RouteVerb }): Promise<boolean> {
  const proxy = (await import('../../../proxy')).default as unknown as (
    request: NextRequest,
  ) => Promise<Response | undefined> | Response | undefined;
  let answer: Response | undefined;
  try {
    answer = await proxy(noSessionRequest(route));
  } catch {
    // Clerk's `protect()` throws to redirect to its sign-in: not through.
    return false;
  }
  // Clerk's handler returns nothing for a route it lets through; the others answer `next()`.
  return answer === undefined || answer.headers.get('x-middleware-next') === '1';
}

beforeEach((): void => {
  asked.length = 0;
  // A refused request reaches no network either: no vendor, no model, no deployment.
  vi.stubGlobal('fetch', async (input: unknown): Promise<never> => {
    asked.push(`fetch ${String(input)}`);
    throw new Error('a refused request reached the network');
  });
});

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the routes a request with no session reaches', (): void => {
  it('reads every route under app/api, and names only routes that exist', (): void => {
    expect(ROUTES.length).toBeGreaterThan(10);
    const keys = new Set(ROUTES.map((route) => `${route.verb} ${route.path}`));
    for (const entry of NO_SESSION_ROUTES) expect(keys).toContain(`${entry.verb} ${entry.path}`);
  });

  it.each(GATED_SIGN_IN_MODES)(
    'lets a request with no session reach exactly the handlers named for the %s mode',
    async (mode): Promise<void> => {
      await useSignInMode(mode);
      const through: string[] = [];
      for (const route of ROUTES) {
        if (await reachesHandler(route)) through.push(`${route.verb} ${route.path}`);
      }
      const expected = NO_SESSION_ROUTES.filter((entry) =>
        (entry.reachableIn as readonly string[]).includes(mode),
      ).map((entry) => `${entry.verb} ${entry.path}`);
      expect(through.sort()).toEqual(expected.sort());
    },
  );

  it.each(['no-sign-in', 'local-key', 'clerk', 'company'] as const)(
    'has every handler not named for it refuse a request with no session itself, asking the deployment nothing (%s)',
    async (mode): Promise<void> => {
      await useSignInMode(mode);
      for (const route of ROUTES.filter((candidate) => {
        const entry = named(candidate);
        return entry === undefined || entry.admission === 'handler-refuses';
      })) {
        asked.length = 0;
        const handlers = (await import(/* @vite-ignore */ join(ROOT, route.file))) as Record<
          RouteVerb,
          (request: Request) => Promise<Response>
        >;
        const response = await handlers[route.verb](noSessionRequest(route));
        const label = `${route.verb} ${route.path} under ${mode}`;
        expect([401, 403, 404], label).toContain(response.status);
        const body = (await response.json()) as Record<string, unknown>;
        expect(Object.keys(body), label).toEqual(['error']);
        expect(asked, label).toEqual([]);
      }
    },
  );

  it.each(['no-sign-in', ...GATED_SIGN_IN_MODES] as const)(
    'has every route a signed secret admits refuse a request with neither a session nor the secret, asking nothing (%s)',
    async (mode): Promise<void> => {
      await useSignInMode(mode);
      for (const route of ROUTES.filter(
        (candidate) => named(candidate)?.admission === 'signed-secret',
      )) {
        asked.length = 0;
        const handlers = (await import(/* @vite-ignore */ join(ROOT, route.file))) as Record<
          RouteVerb,
          (request: Request) => Promise<Response>
        >;
        const response = await handlers[route.verb](noSessionRequest(route));
        const label = `${route.verb} ${route.path} under ${mode}`;
        expect([307, 401, 503], label).toContain(response.status);
        if (response.status === 307) {
          // Sent back to this deployment's own landing with the outcome, never to a caller's address.
          expect(new URL(response.headers.get('location') ?? '').origin, label).toBe(APP);
        } else {
          const body = (await response.json()) as Record<string, unknown>;
          expect(Object.keys(body), label).toEqual(['error']);
        }
        expect(asked, label).toEqual([]);
      }
    },
  );

  it('has its own test of what a request with no session gets, for every route it names', (): void => {
    for (const entry of NO_SESSION_ROUTES) {
      const directory = join(ROOT, 'tests', 'app', entry.path);
      const tests = existsSync(directory)
        ? readdirSync(directory).filter((file) => /^route.*\.test\.ts$/.test(file))
        : [];
      expect(tests.length, entry.path).toBeGreaterThan(0);
    }
  });
});
