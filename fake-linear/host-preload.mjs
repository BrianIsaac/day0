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

import { rerouteOf } from './host-reroute.mjs';

const fake = process.env.FAKE_LINEAR_HOST_URL?.trim();
// Fail closed: a preload without the fake named would leave every fetch to Linear going to Linear.
if (!fake) {
  throw new Error(
    'FAKE_LINEAR_HOST_URL is unset: name the fake Linear this machine reaches (https://127.0.0.1:<port>), or do not load the preload.',
  );
}
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
