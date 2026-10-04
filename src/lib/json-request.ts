import { NextResponse } from 'next/server';
import { PUBLIC_URL_VAR } from './customer-oidc';
import { publicOrigin, serverEnv } from './customer-sign-in-settings';
import type { EnvReader } from './hosted-markers';

/**
 * The two checks a browser-called POST route makes before it trusts a request:
 * that the page which sent it is this app's own, and that its body is JSON of a
 * bounded size.
 *
 * `SameSite=Lax` keeps the unlock session off cross-site requests, but a page
 * served from another port on localhost is the same site, so its `fetch` would
 * carry the session. The `Origin` header names the port, so it is what tells
 * the two apart. Requiring `application/json` means a plain HTML form, which
 * needs no preflight, cannot produce a body these routes accept.
 */

/** A body read that either produced a value or the response to refuse with. */
export type JsonBody = { ok: true; value: unknown } | { ok: false; refusal: NextResponse };

/**
 * The refusal for a request another origin's page sent, or undefined when the
 * request came from this app or from no browser at all.
 *
 * A browser always sends `Origin` on a POST, and `Sec-Fetch-Site` on any
 * request it makes; a request with neither was not made by a page, so it cannot
 * be a page riding this browser's session.
 *
 * This app's pages are served on the origin people reach it on
 * (`DAY0_PUBLIC_URL`) and on the request's own. Under `next start` the
 * request's URL is built on `http://localhost:<port>` whatever the `Host` or
 * forwarded headers say, so without the public origin every page served
 * through a proxy, or on `127.0.0.1`, was refused (wave 12, G-F5). A forwarded
 * header is never read for it: any client can send one.
 *
 * @param request - The incoming request; its own URL gives one of this app's origins.
 * @param read - Reads `DAY0_PUBLIC_URL`; the process's environment unless a test passes one.
 */
export function crossOriginRefusal(
  request: Request,
  read: EnvReader = serverEnv,
): NextResponse | undefined {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const refused =
    origin !== null
      ? !ownOrigins(request, read).includes(origin)
      : site !== null && site !== 'same-origin' && site !== 'none';
  if (!refused) return undefined;
  return NextResponse.json(
    { error: 'this route accepts requests from the pages of this app only' },
    { status: 403 },
  );
}

/**
 * The origins this app's pages are served on: the request's own and, when
 * `DAY0_PUBLIC_URL` is an origin, that one. A value that is not an origin adds
 * nothing (`check:setup` names it), so it cannot widen what is accepted.
 */
function ownOrigins(request: Request, read: EnvReader): readonly string[] {
  const own = new URL(request.url).origin;
  const configured = read(PUBLIC_URL_VAR)?.trim();
  if (!configured) return [own];
  const configuredOrigin = publicOrigin(configured);
  return 'origin' in configuredOrigin ? [own, configuredOrigin.origin] : [own];
}

/**
 * Read a JSON body of at most `limitBytes`, stopping as soon as it is exceeded.
 *
 * @param request - The incoming request.
 * @param limitBytes - The largest body accepted, in bytes.
 * @returns The parsed value, or a 415, 413 or 400 refusal.
 */
export async function readJsonBody(request: Request, limitBytes: number): Promise<JsonBody> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return refusal('the body must be application/json', 415);
  }
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limitBytes) {
    return refusal(`the body is larger than ${limitBytes} bytes`, 413);
  }
  const text = await readBounded(request, limitBytes);
  if (text === undefined) return refusal(`the body is larger than ${limitBytes} bytes`, 413);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // Not JSON is the caller's fault and the answer says so; nothing to log.
    return refusal('the body is not valid JSON', 400);
  }
}

/** The body as text, or undefined once more than `limitBytes` have arrived. */
async function readBounded(request: Request, limitBytes: number): Promise<string | undefined> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel('request body limit reached');
      return undefined;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

function refusal(error: string, status: number): JsonBody {
  return { ok: false, refusal: NextResponse.json({ error }, { status }) };
}
