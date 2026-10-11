import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  isDiallablePrivateAddress,
  isFakeIpAddress,
  isNonPublicAddress,
} from '../../lib/network-addresses';
import {
  configuredPrivateHosts,
  isPrivateHostAllowed,
  PRIVATE_HOSTS_VAR,
  type PrivateHostAllowlist,
} from '../../lib/private-hosts';
import {
  approvedMcpEndpoint,
  McpAddressRefusal,
  resolveHostname,
  type HostResolver,
} from '../../surfaces/mcp-address';

/**
 * Where the URLs reader may fetch a documentation page from (R9 of the wave 3.5 review).
 *
 * A URL source names its pages, and a page can redirect anywhere, so without a check the
 * deployment fetches whatever a link names: a metadata address, this machine, a server inside
 * the network it runs in. Every page and every address a redirect leads to is held to the MCP
 * rung's address rules: a public host over https, or a host the operator listed in
 * `DAY0_PRIVATE_HOSTS` answering with a private address, never loopback, link-local, multicast or
 * unspecified. Plain http is read only from a listed host. The name is resolved once and the
 * request dials only the addresses checked, so a later DNS answer cannot move it (DNS rebinding).
 */

/** Why the reader would not fetch a page; its message is the page's reason on the source card. */
export class PageAddressRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageAddressRefusal';
  }
}

/** A page address that passed the rules, and the addresses its host answered with. */
export interface CheckedPageAddress {
  readonly url: URL;
  readonly addresses: readonly string[];
}

/** A fetch-shaped call for one checked page address. */
export type PageFetch = (input: URL, init?: RequestInit) => Promise<Response>;

/** The `http.request` and `https.request` shape the pinned transport dials with. */
export type PageRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => {
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(body?: string | Uint8Array): unknown;
};

/** The operator's list, or the refusal a list the environment cannot parse gives every page. */
function listedHosts(
  url: URL,
  privateHosts: PrivateHostAllowlist | undefined,
): PrivateHostAllowlist {
  if (privateHosts !== undefined) return privateHosts;
  try {
    return configuredPrivateHosts();
  } catch (error) {
    throw new PageAddressRefusal(
      `${url.href}: ${PRIVATE_HOSTS_VAR} cannot be read, so Day0 reads no page until it is corrected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Whether a page's host is one the operator listed in `DAY0_PRIVATE_HOSTS`, read as
 * `checkPageAddress` reads it.
 *
 * @param url - The page, or the address a redirect leads to.
 * @param privateHosts - The operator's list; the environment's when omitted.
 * @throws PageAddressRefusal when the environment's list cannot be read.
 */
export function isListedPageHost(url: URL, privateHosts?: PrivateHostAllowlist): boolean {
  return isPrivateHostAllowed(url.hostname.replace(/^\[|\]$/g, ''), listedHosts(url, privateHosts));
}

/**
 * Hold one page address to the rules, resolving its host once.
 *
 * @param url - The page, or the address a redirect leads to.
 * @param resolve - The resolver; the system's by default.
 * @param privateHosts - The operator's list; the environment's when omitted.
 * @returns The address and the host's answers, every one checked.
 * @throws PageAddressRefusal naming the page and why, before any socket opens.
 */
export async function checkPageAddress(
  url: URL,
  resolve: HostResolver = resolveHostname,
  privateHosts?: PrivateHostAllowlist,
): Promise<CheckedPageAddress> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PageAddressRefusal(`${url.href} is not an http or https address.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new PageAddressRefusal(
      `${url.href} carries a user name or password, which Day0 does not send.`,
    );
  }
  const listed = listedHosts(url, privateHosts);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isListed = isPrivateHostAllowed(hostname, listed);
  if (url.protocol === 'http:' && !isListed) {
    throw new PageAddressRefusal(
      `${url.href} is plain http on a host ${PRIVATE_HOSTS_VAR} does not list; Day0 reads a public page over https only.`,
    );
  }
  // The MCP rung's name rule, which knows the names and literals that are private by pattern;
  // the scheme is judged above, so it is asked about the same host over https.
  const named = new URL(url.href);
  named.protocol = 'https:';
  named.hash = '';
  try {
    approvedMcpEndpoint(named.href, listed);
  } catch (error) {
    if (!(error instanceof McpAddressRefusal)) throw error;
    throw new PageAddressRefusal(
      `${url.href} names a host inside a private network that ${PRIVATE_HOSTS_VAR} does not list, so Day0 does not read it.`,
    );
  }
  const addresses = await resolvedAddresses(url, hostname, resolve);
  if (isListed && !addresses.every(isDiallablePrivateAddress)) {
    throw new PageAddressRefusal(
      `${url.href}: its host is listed in ${PRIVATE_HOSTS_VAR} but answers with a loopback, link-local, multicast or unspecified address, which Day0 never reads from.`,
    );
  }
  // A listed name is a server inside the operator's network; one that answers publicly is read
  // over https like any public page, never in the clear (W14-R34).
  if (url.protocol === 'http:' && isListed && !addresses.every(isNonPublicAddress)) {
    throw new PageAddressRefusal(
      `${url.href} is plain http, and its host, though ${PRIVATE_HOSTS_VAR} lists it, answers with a public address: Day0 reads plain http only from a host inside your network.`,
    );
  }
  const fakeIp = isListed ? undefined : addresses.find(isFakeIpAddress);
  if (fakeIp !== undefined) {
    throw new PageAddressRefusal(
      `${url.href}: its host answers with ${fakeIp}, an address of the range a fake-IP proxy hands out (198.18.0.0/15), so Day0 cannot tell what it reaches and does not read it. Set the proxy\u2019s DNS to answer real addresses, or list the host in ${PRIVATE_HOSTS_VAR}.`,
    );
  }
  if (!isListed && addresses.some(isNonPublicAddress)) {
    throw new PageAddressRefusal(
      `${url.href}: its host answers with a private, loopback, link-local or otherwise non-public address and ${PRIVATE_HOSTS_VAR} does not list it, so Day0 does not read it.`,
    );
  }
  return { url, addresses };
}

/** Every address a page's host answers with: the literal itself, or the resolver's answers. */
async function resolvedAddresses(
  url: URL,
  hostname: string,
  resolve: HostResolver,
): Promise<string[]> {
  if (isIP(hostname) !== 0) return [hostname];
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'EAI_NODATA') {
      throw new PageAddressRefusal(`${url.href}: its host does not resolve.`);
    }
    throw new Error(`${url.href}: Day0's resolver did not answer for its host.`, { cause: error });
  }
  if (addresses.length === 0)
    throw new PageAddressRefusal(`${url.href}: its host does not resolve.`);
  return addresses;
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

/** A byte count as a page's reason says it: in whole mebibytes when it is some. */
function byteSize(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return Number.isInteger(mebibytes) ? `${mebibytes} MiB` : `${bytes} bytes`;
}

/**
 * How the reader introduces itself and the encodings it reads, as a browser's fetch would send
 * them: some wikis refuse a request with no `User-Agent`, and a page sent compressed is decoded.
 */
const READER_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'Day0 documentation reader',
  'accept-encoding': 'gzip, deflate, br',
};

/**
 * A response's body decoded by its `Content-Encoding`, or the body as sent when it names none.
 *
 * @returns The stream to read, and whether it was decoded.
 * @throws Error naming an encoding the reader does not decode.
 */
function decodedBody(url: URL, response: IncomingMessage): { body: Readable; decoded: boolean } {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  if (encoding === '' || encoding === 'identity') return { body: response, decoded: false };
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : undefined;
  if (decoder === undefined) {
    response.destroy();
    throw new Error(`${url.href} was sent in an encoding Day0 does not read (${encoding}).`);
  }
  response.on('error', (error: Error): void => {
    decoder.destroy(error);
  });
  return { body: response.pipe(decoder), decoded: true };
}

/**
 * A page's body ran past the most the fetch reads of it.
 *
 * An error of its own, so a reader tells a page that is too large, which is that page's and stays
 * so at the next sync, from a read that failed and is worth another try (W15-R11).
 */
export class PageTooLargeError extends Error {
  constructor(url: URL, limitBytes: number) {
    super(`${url.href} exceeds ${byteSize(limitBytes)}.`);
    this.name = 'PageTooLargeError';
  }
}

/** A body that errors once more than `limit` bytes have arrived, counted after decoding. */
function boundedBody(url: URL, response: Readable, limit: number): ReadableStream<Uint8Array> {
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
          fail(new PageTooLargeError(url, limit));
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
      response.on('close', (): void => fail(new Error(`${url.href} closed the connection.`)));
    },
    cancel(): void {
      settled = true;
      response.destroy();
    },
  });
}

/**
 * A fetch that reaches one checked page address through its checked addresses only.
 *
 * Another host or scheme is refused before a socket opens, a redirect is returned for the
 * caller to check and follow, a compressed body is decoded, and at most `limitBytes` of the
 * decoded body is read.
 *
 * @param checked - The address and answers `checkPageAddress` returned.
 * @param limitBytes - The largest body read.
 * @param requests - The http and https transports; Node's by default.
 */
export function pinnedPageFetch(
  checked: CheckedPageAddress,
  limitBytes: number,
  requests: { readonly http: PageRequest; readonly https: PageRequest } = {
    http: httpRequest,
    https: httpsRequest,
  },
): PageFetch {
  const lookup = pinnedLookup(checked.addresses);
  return async (input: URL, init: RequestInit = {}): Promise<Response> => {
    if (input.protocol !== checked.url.protocol || input.host !== checked.url.host) {
      throw new PageAddressRefusal(
        `Day0 refused to fetch ${input.href}, which is not the address it checked.`,
      );
    }
    const headers: Record<string, string> = { ...READER_HEADERS };
    new Headers(init.headers).forEach((value: string, key: string): void => {
      headers[key] = value;
    });
    const request = input.protocol === 'https:' ? requests.https : requests.http;
    return await new Promise<Response>((resolve, reject): void => {
      const outgoing = request(
        input,
        {
          method: init.method ?? 'GET',
          headers,
          lookup,
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
            const { body, decoded } = empty
              ? { body: undefined, decoded: false }
              : decodedBody(input, response);
            // The body read is the decoded one, so the sent encoding and length no longer apply.
            if (decoded) {
              responseHeaders.delete('content-encoding');
              responseHeaders.delete('content-length');
            }
            resolve(
              new Response(body === undefined ? null : boundedBody(input, body, limitBytes), {
                status,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders,
              }),
            );
          } catch (error) {
            // A status outside 200-599 cannot be a Response; the read fails with it.
            response.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      // As the global fetch words a transport failure, so a page's reason reads the same.
      outgoing.on('error', (error: Error): void =>
        reject(new TypeError('fetch failed', { cause: error })),
      );
      outgoing.end();
    });
  };
}
