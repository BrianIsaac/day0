/**
 * A Feishu tenant answered in-process from the fixtures beside this file.
 *
 * The fixtures were written on 8 October 2026 from the response shapes Feishu
 * documents (`tenant.json` names each route and the file that answers it):
 * written from the reference, not recorded from a tenant, and no tenant was
 * called (W14-R43). The double checks what the real API checks that the
 * reader depends on: the app's id and secret at the token route, and a token
 * it issued on every other route.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORY = join(import.meta.dirname, '.');

/** One fixture route: the request it answers and the fixture file it answers with. */
interface FixtureRoute {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly status: number;
  readonly body: string;
}

/** The fixture tenant: its app, its wiki space and folder, and every route. */
export interface FeishuTenant {
  readonly app: { readonly appId: string; readonly appSecret: string };
  readonly spaceId: string;
  readonly folderToken: string;
  readonly nodes: Readonly<Record<string, { readonly node: string; readonly obj: string }>>;
  readonly folder: Readonly<Record<string, string>>;
  readonly routes: readonly FixtureRoute[];
}

/** The fixture tenant, as `tenant.json` describes it. */
export const feishuTenant: FeishuTenant = JSON.parse(
  readFileSync(join(DIRECTORY, 'tenant.json'), 'utf8'),
) as FeishuTenant;

/** One request the double answered, with the clock reading when it arrived. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization?: string;
  readonly at: number;
}

/** A response a test puts in place of the fixture's, or undefined to keep it. */
export type RequestOverride = (request: RecordedRequest) => Response | undefined;

/** A fixture's body as JSON text. */
function fixtureBody(name: string): string {
  return readFileSync(join(DIRECTORY, name), 'utf8');
}

/** Whether a route answers this request: the method, the path and exactly its query. */
function matches(route: FixtureRoute, method: string, url: URL): boolean {
  if (route.method !== method || route.path !== url.pathname) return false;
  const expected = Object.entries(route.query ?? {}).sort();
  const actual = [...url.searchParams.entries()].sort();
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/**
 * A fetch that answers from the fixture tenant.
 *
 * @param options - The tokens the token route issues in turn (the last repeats), the clock the
 *   requests are stamped with, and an override for a test's own answer.
 * @returns The fetch and the requests it answered, in order.
 */
export function feishuTenantFetch(
  options: {
    readonly tokens?: readonly string[];
    readonly now?: () => number;
    readonly override?: RequestOverride;
  } = {},
): {
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  readonly requests: RecordedRequest[];
} {
  const tokens = options.tokens ?? ['t-fixture-tenant-token'];
  const issued: string[] = [];
  const requests: RecordedRequest[] = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  const fetch = async (input: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    const authorization = new Headers(init.headers).get('authorization') ?? undefined;
    const request: RecordedRequest = {
      method,
      url: new URL(input),
      authorization,
      at: options.now?.() ?? 0,
    };
    requests.push(request);
    const replaced = options.override?.(request);
    if (replaced !== undefined) return replaced;
    if (request.url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      const body = JSON.parse(String(init.body)) as { app_id?: string; app_secret?: string };
      if (
        body.app_id !== feishuTenant.app.appId ||
        body.app_secret !== feishuTenant.app.appSecret
      ) {
        return json(400, { code: 10014, msg: 'app secret invalid' });
      }
      const token = tokens[Math.min(issued.length, tokens.length - 1)];
      issued.push(token);
      return json(200, { code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 });
    }
    if (!issued.some((token) => authorization === `Bearer ${token}`)) {
      return json(400, { code: 99991663, msg: 'Invalid access token for authorization.' });
    }
    const route = feishuTenant.routes.find((candidate) =>
      matches(candidate, method, request.url),
    );
    if (route === undefined) return json(404, { code: 131005, msg: 'not found' });
    return new Response(fixtureBody(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  return { fetch, requests };
}
