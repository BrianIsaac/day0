import { query } from './_generated/server';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { modelName } from '../src/lib/model-name';
import { browserComponent } from '../src/surfaces/browser';
import { evaluationBedName } from '../src/evaluation/bed-flag';

/** Return the non-secret surface mode for consistent UI labels. */
export const surfaceMode = query({
  args: {},
  handler: (): { mode: 'mock' | 'real'; label: string } => ({
    mode: SURFACE_MODE,
    label: SURFACE_MODE === 'real' ? 'real (local)' : 'mock',
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

/**
 * The release this deployment's functions are stamped at, and when, or null
 * on one never stamped.
 *
 * Public with no guard: the release is the same for every caller and is
 * published in the repository, and `/setup` states it to signed-out visitors
 * as a dated fact. The commit the stamp records is left out; a page has no
 * use for it. Reads the newest of the stamps the upgrade writes.
 */
export const release = query({
  args: {},
  handler: async (ctx): Promise<{ release: string; recordedAt: number } | null> => {
    const stamp = await ctx.db.query('deploymentVersions').order('desc').first();
    return stamp === null ? null : { release: stamp.release, recordedAt: stamp.recordedAt };
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
