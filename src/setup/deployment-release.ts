import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { dayLabelAt } from '../demo/day-label';
import { log } from '../lib/logger';

/** The release a deployment's functions are stamped at, and when. */
export interface DeploymentRelease {
  readonly release: string;
  /** When that release was first stamped, in milliseconds since the epoch. */
  readonly since: number;
}

/** How long a page waits for the stamp before it renders without it. */
const READ_TIMEOUT_MS = 3_000;

/**
 * The zone a release stamp's day is read in. The hosted deployment has no
 * manager whose zone could date it, so it is dated on the operator's and the
 * venue's clock, and the sentence names the zone (a stamp carries its zone, N12).
 */
const DEPLOYMENT_ZONE = 'Asia/Singapore';

/** How the release sentence names `DEPLOYMENT_ZONE` to a reader. */
const DEPLOYMENT_ZONE_NAME = 'Singapore time';

/**
 * The sentence stating the release the deployment behind a page is at, as a
 * dated fact that stays true when the next release is stamped.
 *
 * @param stamp - The deployment's newest release stamp.
 */
export function deploymentReleaseLine(stamp: DeploymentRelease): string {
  const day = dayLabelAt(stamp.since, DEPLOYMENT_ZONE);
  return `The deployment behind this page has been at v${stamp.release} since ${day}, ${DEPLOYMENT_ZONE_NAME}.`;
}

/**
 * Read the release the deployment behind this app is stamped at, or `null`
 * when the app names none, it has no stamp, or it does not answer in time.
 *
 * The address is the server's own (`CONVEX_URL`), else the browser's
 * (`NEXT_PUBLIC_CONVEX_URL`), the rule `serverConvexUrl` applies to the
 * routes; that module is not imported because it brings the sign-in
 * providers into a page that signs nobody in. A page renders
 * without the line rather than fail on it, so a failure is logged and `null`.
 *
 * @param env - The environment to read the address from.
 * @param fetchImpl - The transport; the global `fetch` by default, bounded by a timeout.
 */
export async function readDeploymentRelease(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentRelease | null> {
  const url = env.CONVEX_URL?.trim() || env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) return null;
  try {
    const client = new ConvexHttpClient(url, {
      logger: false,
      fetch: async (input, init) =>
        await fetchImpl(input, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) }),
    });
    return await client.query(api.config.release, {});
  } catch (error) {
    log.warn('deployment release not read; the page states no release', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
