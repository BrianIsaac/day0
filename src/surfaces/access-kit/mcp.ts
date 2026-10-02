import type { AccessRecipe } from './types';

/*
 * An MCP server in the access kit (the access plan, section 4.6; B12, AC7): IT registers Day0 as a
 * client with the server's authorisation server (pre-registered, never dynamic by default) and
 * hands the setup verb the client id, and the secret for a confidential client. Each employee's
 * card then authorises through the manager's own browser (11-AM), so the connection is per
 * employee; a shared MCP connection is refused per card until a flow obtains a shared token (AM5).
 */

/** The path the MCP authorisation returns to (11-AM's route, `app/api/oauth/mcp`). */
export const MCP_REDIRECT_PATH = '/api/oauth/mcp';

/** An MCP server's recipe: one pre-registered client per server. */
export const MCP_RECIPE: AccessRecipe = {
  system: 'mcp',
  displayName: 'MCP server',
  guide: 'docs/running/access-mcp.md',
  redirectPath: MCP_REDIRECT_PATH,
  vendorHosts: [],
  modes: [
    {
      mode: 'per-employee',
      kind: 'mcp-client',
      scopes: [],
      summary:
        "Register Day0 as a client with the server's authorisation server, with Day0's redirect, " +
        'and hand over the client id (and the secret, for a confidential client).',
      asks: [
        {
          field: 'serverUrl',
          label: "The MCP server's https address",
          secret: false,
          stdinName: 'MCP_SERVER_URL',
          optional: false,
        },
        {
          field: 'clientId',
          label: 'The client id IT registered',
          secret: false,
          stdinName: 'MCP_CLIENT_ID',
          optional: false,
        },
        {
          field: 'secret',
          label: 'The client secret (hidden; Enter for a public client)',
          secret: true,
          stdinName: 'MCP_CLIENT_SECRET',
          optional: true,
        },
        {
          field: 'issuer',
          label:
            "The authorisation server's issuer URL (Enter to discover it at the first sign-in)",
          secret: false,
          stdinName: 'MCP_ISSUER',
          optional: true,
        },
        {
          field: 'scopes',
          label: 'The scopes IT granted, comma-separated (Enter for what the server offers)',
          secret: false,
          stdinName: 'MCP_SCOPES',
          optional: true,
        },
      ],
      secretLifetime: {
        words:
          'As the authorisation server sets it: ask IT when the client secret expires and keep ' +
          'the date in the install record; a public client has none.',
      },
      landsAtInstall: true,
    },
  ],
};
