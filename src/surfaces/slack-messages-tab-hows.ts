/*
 * How Day0 knows an employee's own Slack app takes messages (W12V-7), in a module that imports
 * nothing: `convex/schema.ts` declares `surfaces.provisioning.messagesTab` from it, and a module the
 * schema imports must read no environment variable at load, which the backend refuses while it
 * evaluates a schema (the day0-w13k bed, 5 October). `slack-messages-tab.ts` re-exports both.
 */

/**
 * How Day0 knows an app takes messages: `created` from a manifest that opens the tab; `opened` by
 * Day0's own `apps.manifest.update`; `found-open` when Day0 read the app's manifest and someone had
 * opened it already; `confirmed` on the manager's word, for an app Day0 cannot read.
 */
export const MESSAGES_TAB_OPEN_HOWS = ['created', 'opened', 'found-open', 'confirmed'] as const;

/** One of {@link MESSAGES_TAB_OPEN_HOWS}. */
export type MessagesTabOpenHow = (typeof MESSAGES_TAB_OPEN_HOWS)[number];
