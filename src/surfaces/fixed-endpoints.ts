import { isSlackApiEndpoint } from './slack-endpoint';

/*
 * The provider addresses Day0 fixes itself rather than reads from an owner's documentation: the
 * same for every workspace, they are nobody's documentation, so a handover's cut keeps them on a
 * card (the wave 9 review's section 3) while it clears a documented one, a tenant's host among
 * them.
 */

/** The one MCP server this deployment's kanban intake reader speaks to. */
export const LINEAR_MCP_ENDPOINT = 'https://mcp.linear.app/mcp';

/**
 * Whether Day0 fixes this address itself: Slack's Web API base (`isSlackApiEndpoint`) or the
 * Linear MCP server intake reads.
 *
 * @param endpoint - A card's endpoint, when it has one.
 */
export function isDay0FixedEndpoint(endpoint: string | undefined): boolean {
  return endpoint === LINEAR_MCP_ENDPOINT || isSlackApiEndpoint(endpoint);
}
