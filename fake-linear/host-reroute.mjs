/**
 * Where the bed's host preload (`host-preload.mjs`) sends a request to one of Linear's names: the
 * fake Linear's published port, with the path and the query kept. Pure, so a test reads it without
 * loading the preload.
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
