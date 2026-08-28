import { query } from './_generated/server';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { browserComponent } from '../src/surfaces/browser';

/** Return the non-secret surface mode for consistent UI labels. */
export const surfaceMode = query({
  args: {},
  handler: (): { mode: 'mock' | 'real'; label: string } => ({
    mode: SURFACE_MODE,
    label: SURFACE_MODE === 'real' ? 'real (local)' : 'mock',
  }),
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
