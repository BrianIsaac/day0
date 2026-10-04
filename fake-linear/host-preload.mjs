/**
 * A bed's preload for this machine's Node processes (`check:access`, `./setup.sh access`), which
 * resolve Linear's names with the machine's own resolver and so cannot see the compose network's
 * aliases: every `fetch` to `api.linear.app`, `linear.app` or `mcp.linear.app` goes to the fake
 * Linear's published port instead, and any other `linear.app` host is refused, so nothing a bed
 * runs reaches Linear itself. Loaded with
 *
 *   NODE_OPTIONS="--import <checkout>/fake-linear/host-preload.mjs"
 *   FAKE_LINEAR_HOST_URL=https://127.0.0.1:<the fake's published port>
 *   NODE_EXTRA_CA_CERTS=<checkout>/fake-linear/tls/cas.pem
 *
 * Only the global `fetch` is rerouted: a process that dials Linear another way is not covered, and
 * the bed's recipe says which processes it covers. Never loaded outside a bed.
 */

/** The hosts Day0 names for Linear, each answered by the fake. */
export const LINEAR_HOSTS = Object.freeze(['api.linear.app', 'linear.app', 'mcp.linear.app']);

/**
 * Where a request to Linear goes instead, or why it is refused; nothing for a request to anywhere
 * else.
 *
 * @param {URL} url
 * @param {string} fake the fake's base URL, as this machine reaches it
 * @returns {{ rerouted: URL } | { refused: string } | undefined}
 */
export function rerouteOf(url, fake) {
  if (LINEAR_HOSTS.includes(url.hostname)) {
    return { rerouted: new URL(`${url.pathname}${url.search}`, fake) };
  }
  if (url.hostname.endsWith('.linear.app')) {
    return {
      refused: `${url.hostname} is not answered by the bed's fake Linear, and Linear itself is never called from a bed.`,
    };
  }
  return undefined;
}

const fake = process.env.FAKE_LINEAR_HOST_URL?.trim();
if (fake) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = rerouteOf(url, fake);
    if (route === undefined) return await real(input, init);
    if ('refused' in route) throw new Error(route.refused);
    return input instanceof Request
      ? await real(new Request(route.rerouted, input), init)
      : await real(route.rerouted, init);
  };
}
