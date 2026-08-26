# Linear automation

Linear is the team's formal work queue and audit trail. Day0 works only in team `REVOPS`, project `Q3 close`.

## Where it is

- Integration endpoint: Linear's MCP server, Streamable HTTP, `https://mcp.linear.app/mcp`. Authentication is a bearer token in the `Authorization` header.
- Tools the automation is allowed to use: `list_issues`, `get_issue`, `list_comments`, `save_comment`, `save_issue`.

## Access

- Owner: the work management administrator.
- The automation uses a personal API key created for it, scoped to this workspace.
- Service token (RevOps automation): <credential: linear service token, stored>
- Rotation: create a new key in Linear, replace the stored value and revoke the old key.
