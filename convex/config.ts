import { v } from 'convex/values';
import { query } from './_generated/server';
import { getCaller, verifiedAddressOf } from './ownership';
import {
  resolveDeploymentProfile,
  SURFACE_MODE,
  type DeploymentProfile,
} from '../src/lib/surface-mode';
import { modelName } from '../src/lib/model-name';
import { browserComponent } from '../src/surfaces/browser';
import { evaluationBedName } from '../src/evaluation/bed-flag';

/**
 * Return the non-secret surface mode for consistent UI labels, and the deployment profile, so
 * People can say which installation it is without guessing from the mode (the transfer plan,
 * section 8): under `local-dev` with the local sign-in every browser is one manager, and a
 * handover has nobody to go to. Public with no guard; both are the same for every caller.
 */
export const surfaceMode = query({
  args: {},
  handler: (): { mode: 'mock' | 'real'; label: string; deploymentProfile: DeploymentProfile } => ({
    mode: SURFACE_MODE,
    label: SURFACE_MODE === 'real' ? 'real (local)' : 'mock',
    deploymentProfile: resolveDeploymentProfile(),
  }),
});

/**
 * The model this deployment's actions are configured to call, by name only.
 *
 * The evaluation harness compares it with the model the local environment
 * names, so that the evidence file records the model that actually ran both
 * arms rather than whatever the operator's shell happened to say. It also
 * names the evaluation bed the deployment is, if any, so a harness refuses
 * before it spends anything (N9). Nothing about the provider - key, base URL
 * - is returned.
 */
export const modelSettings = query({
  args: {},
  handler: (): {
    model: string;
    skillSandboxBackend: 'daytona' | 'local';
    evaluationBed: string | null;
  } => ({
    model: modelName(),
    skillSandboxBackend: process.env.DAYTONA_API_KEY?.trim() ? 'daytona' : 'local',
    evaluationBed: evaluationBedName() ?? null,
  }),
});

/** How many stamps `release` reads back to find when the newest release was first stamped. */
const RELEASE_STAMPS_READ = 50;

/**
 * The release this deployment's functions are stamped at, and since when, or null
 * on one never stamped.
 *
 * Public with no guard: the release is the same for every caller and is
 * published in the repository, and `/setup` states it to signed-out visitors
 * as a dated fact. The commit the stamp records is left out; a page has no
 * use for it. "Since" is the first of the newest run of stamps naming that
 * release, within the last fifty.
 */
export const release = query({
  args: {},
  handler: async (ctx): Promise<{ release: string; since: number } | null> => {
    const stamps = await ctx.db.query('deploymentVersions').order('desc').take(RELEASE_STAMPS_READ);
    const newest = stamps[0];
    if (newest === undefined) return null;
    // A re-push of the same release stamps it again with its new commit; the
    // release has been there since the first stamp of the newest run.
    let since = newest.recordedAt;
    for (const stamp of stamps) {
      if (stamp.release !== newest.release) break;
      since = stamp.recordedAt;
    }
    return { release: newest.release, since };
  },
});

/** Which optional components this deployment is configured for. */
export interface ComponentStatus {
  /** Whether a browser driver is configured, so the browser floor can run. */
  browser: boolean;
}

/**
 * Report the optional components, so a card can say what it cannot do.
 *
 * A query is the only thing the Surfaces tab can ask before anything has been
 * probed, and a query cannot open a connection - so this reports what is
 * *configured*, not what is answering. Reachability is decided where a
 * connection is actually made, and reaches the card through the reason the
 * probe recorded on the row. No address is returned: which components exist is
 * not a secret, but their internal addresses are nobody's business in a page.
 */
export const components = query({
  args: {},
  handler: (): ComponentStatus => {
    let browser = false;
    try {
      browser = browserComponent(process.env.DAY0_BROWSER_MCP_URL).present;
    } catch {
      // A malformed address is reported by `check:setup` and by the probe,
      // with the value in hand. Here it can only mean "not usable".
      browser = false;
    }
    return { browser };
  },
});

/** Who the caller is, as this deployment derived it from the caller's token. */
const whoAmIValidator = v.union(
  v.null(),
  v.object({
    ownerKey: v.string(),
    issuer: v.string(),
    subject: v.string(),
    verifiedAddress: v.union(v.string(), v.null()),
  }),
);

/**
 * Who the caller is, as this deployment sees them: the owner key their rows are
 * keyed on, the issuer and subject it was derived from, and the address their
 * token proves, or null when it proves none. The live sign-in check
 * (`pnpm check:sign-in`) ends on this line: it shows the token reached the
 * deployment, was verified against the issuer's keys and passed the domain rule.
 *
 * Public and guarded to the caller: it answers only about the caller's own
 * token, and null for an anonymous caller or one `getCaller` refuses. Writes
 * nothing.
 */
export const whoAmI = query({
  args: {},
  returns: whoAmIValidator,
  handler: async (ctx) => {
    const caller = await getCaller(ctx);
    if (!caller) return null;
    return {
      ownerKey: caller.ownerKey,
      issuer: caller.issuer,
      subject: caller.subject,
      verifiedAddress: verifiedAddressOf(caller) ?? null,
    };
  },
});
