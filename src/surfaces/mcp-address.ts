import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Where a credential-bearing MCP client may connect, decided once per client.
 *
 * Checking a hostname's DNS answers and then letting the transport resolve it
 * again is a check on a different question from the connection: a name that
 * answered with a public address at probe time can answer with 127.0.0.1 or a
 * metadata address by the time a write connects (DNS rebinding). So the name
 * is resolved once, every answer is checked, and the client dials only the
 * answers it checked. TLS still verifies the certificate against the name.
 */

/** Resolves a hostname to every address it currently answers with. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The `https.request` shape the pinned transport dials with; a test supplies its own. */
export type HttpsRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => {
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(body?: string | Uint8Array): unknown;
};

/** A fetch-shaped function, as the MCP client takes one. */
export type PinnedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** An approved MCP endpoint and the public addresses its hostname answered with when checked. */
export interface CheckedMcpAddress {
  readonly url: URL;
  readonly addresses: readonly string[];
}

/**
 * Why a credential-bearing MCP client was not created.
 *
 * `limitation` is true when the refusal is Day0's own boundary or resolver, and
 * false when it is a fact about the endpoint (its name does not exist), so a
 * caller can tell "Day0 would not" from "the system is not there".
 */
export class McpAddressRefusal extends Error {
  readonly limitation: boolean;

  constructor(message: string, limitation: boolean) {
    super(message);
    this.name = 'McpAddressRefusal';
    this.limitation = limitation;
  }
}

/** Every response body the pinned transport reads is cut off past this many bytes. */
export const MCP_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

const NON_PUBLIC_MCP_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_MCP_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  NON_PUBLIC_MCP_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

/**
 * The one IPv6 range that is globally routable unicast.
 *
 * A denylist of IPv6 ranges cannot be finished: loopback, link-local and
 * unique-local were listed, but `fec0::1` (site-local), `::7f00:1`
 * (IPv4-compatible) and `64:ff9b::7f00:1` (NAT64) were not, and
 * `2002:7f00:1::1` reaches 127.0.0.1 through a 6to4 relay. An address is
 * admitted only if it is inside global unicast and outside the transition and
 * documentation ranges carved out of it above.
 */
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

/**
 * Validate the exact evidence-backed MCP endpoint stored on the approved row.
 *
 * @param endpoint - Evidence-derived surface endpoint.
 * @returns The exact public HTTPS endpoint.
 * @throws McpAddressRefusal when the URL could address this deployment or another private network.
 */
export function approvedMcpEndpoint(endpoint: string | undefined): URL {
  const refusal = (): never => {
    throw new McpAddressRefusal(
      'The approved MCP endpoint must use a public HTTPS hostname. Day0 refused the address before creating a credential-bearing client.',
      true,
    );
  };
  if (!endpoint) return refusal();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return refusal();
  }
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const privateName =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.lan') ||
    !hostname.includes('.');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    hostname === '' ||
    isIP(hostname) !== 0 ||
    privateName
  ) {
    return refusal();
  }
  return parsed;
}

/** Resolve a hostname through the system resolver, every answer included. */
export async function resolveHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

/** Whether one resolved address is outside every public range. */
function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC_MCP_ADDRESSES.check(address, 'ipv4');
  if (family === 6) {
    return (
      !GLOBAL_UNICAST_V6.check(address, 'ipv6') || NON_PUBLIC_MCP_ADDRESSES.check(address, 'ipv6')
    );
  }
  return true;
}

/**
 * Approve an MCP endpoint, resolve its hostname once and check every answer.
 *
 * @param endpoint - The surface's endpoint as stored on the row.
 * @param resolve - The resolver; the system's by default.
 * @returns The endpoint and the public addresses a client must dial.
 * @throws McpAddressRefusal when the endpoint is not approved, the name does not resolve, the
 *   resolver does not answer, or any answer is not a public address.
 */
export async function checkMcpAddress(
  endpoint: string | URL | undefined,
  resolve: HostResolver = resolveHostname,
): Promise<CheckedMcpAddress> {
  const url = approvedMcpEndpoint(endpoint instanceof URL ? endpoint.href : endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    // A name that does not exist is a fact about the enterprise's endpoint; a
    // resolver that would not answer is a fact about this deployment.
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'EAI_NODATA') {
      throw new McpAddressRefusal('The approved MCP endpoint hostname does not resolve.', false);
    }
    throw new McpAddressRefusal(
      'Day0 could not resolve the approved MCP hostname; its own resolver did not answer.',
      true,
    );
  }
  if (addresses.length === 0) {
    throw new McpAddressRefusal('The approved MCP endpoint hostname did not resolve.', false);
  }
  if (addresses.some(isNonPublicAddress)) {
    throw new McpAddressRefusal(
      'The approved MCP hostname resolved to a private, loopback, link-local, reserved or otherwise non-public address. Day0 refused the address before creating a credential-bearing client.',
      true,
    );
  }
  return { url, addresses };
}

/** A lookup that answers with the checked addresses and nothing else. */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address: string) => ({ address, family: isIP(address) }));
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: unknown, family?: number) => void,
  ): void => {
    if (options.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  }) as LookupFunction;
}

/** The request body as the wire takes it; the MCP transports only ever send text. */
function wireBody(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError('the pinned MCP transport sends text or bytes only');
}

/** A response body that errors once more than `limit` bytes have arrived. */
function boundedBody(response: IncomingMessage, limit: number): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      let received = 0;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        controller.error(error);
      };
      response.on('data', (chunk: Buffer): void => {
        if (settled) return;
        received += chunk.byteLength;
        if (received > limit) {
          fail(new Error(`the MCP server's response exceeded ${limit} bytes`));
          response.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      response.on('end', (): void => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      response.on('error', fail);
      response.on('close', (): void => fail(new Error('the MCP server closed the connection')));
    },
    cancel(): void {
      settled = true;
      response.destroy();
    },
  });
}

/**
 * A fetch that reaches the checked endpoint's host through the checked
 * addresses only, and reads at most `limitBytes` of any response.
 *
 * Any other host, and any scheme but https, is refused before a socket opens,
 * so a redirect or a server-supplied URL cannot carry the bearer elsewhere.
 * Redirects are returned, not followed.
 *
 * @param checked - The endpoint and addresses `checkMcpAddress` returned.
 * @param request - The HTTPS transport; Node's by default.
 * @param limitBytes - The largest response body read.
 */
export function pinnedFetch(
  checked: CheckedMcpAddress,
  request: HttpsRequest = httpsRequest as unknown as HttpsRequest,
  limitBytes: number = MCP_RESPONSE_LIMIT_BYTES,
): PinnedFetch {
  const lookupChecked = pinnedLookup(checked.addresses);
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof URL ? input.href : input);
    if (url.protocol !== 'https:' || url.host !== checked.url.host) {
      throw new McpAddressRefusal(
        `Day0 refused to send an MCP request to ${url.protocol}//${url.host}, which is not the checked endpoint.`,
        true,
      );
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value: string, key: string): void => {
      headers[key] = value;
    });
    const body = wireBody(init.body);
    return await new Promise<Response>((resolve, reject): void => {
      const outgoing = request(
        url,
        {
          method: init.method ?? 'GET',
          headers,
          lookup: lookupChecked,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response: IncomingMessage): void => {
          const status = response.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const entry of value) responseHeaders.append(key, entry);
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          const empty =
            status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
          if (empty) response.resume();
          try {
            resolve(
              new Response(empty ? null : boundedBody(response, limitBytes), {
                status,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders,
              }),
            );
          } catch (error) {
            // A status outside 200-599 cannot be a Response; the call fails with it.
            response.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
}
