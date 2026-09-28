# Linear automation

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. The teams and every
ticket in them are invented.

Linear is the company's formal work queue and audit trail. Each team works only in its own team
and project, which its handbook names.

## Where it is

- Workspace: the company's Linear workspace.
- The three teams, each with one project:

| Team | Key | Project |
|---|---|---|
| Revenue operations | `REVOPS` | `Q3 close` |
| Finance close | `FIN` | `September close` |
| Logistics desk | `LOG` | `Shipment exceptions` |

- Issue identifiers are the team key and a number, `FIN-4` for example.
- Workflow states, the same in every team: `Todo`, `In Progress`, `Done`.
- Integration endpoint: Linear's MCP server, Streamable HTTP, `https://mcp.linear.app/mcp`. Authentication is a bearer token in the `Authorization` header.
- Tools the automation is allowed to use: `list_issues`, `get_issue`, `list_comments`, `save_comment`, `save_issue`.

## Access

- Owner: the work management administrator.
- Every digital employee uses the one personal API key created for the company automation, scoped to this workspace.
- Service token (company automation): `PASTE_LINEAR_API_KEY_HERE`
- Rotation: create a new key in Linear (Settings -> Security & access -> Personal API keys), replace the line above, revoke the old key.

## Working rules

- The automation key acts as its human owner, so provenance lives in the content: every comment written by an automation ends with a trailer naming the employee and its run id, and a status change is always preceded by such a comment.
- Comments are created with `save_comment`, sending `issueId` (the issue identifier) and `body` only, never `id` or `parentId`, which rewrite or reply. Comments go on the originating issue.
- Status changes use `save_issue` with `id` and `state`, where `state` is the workspace's exact workflow state name.
- Do not change assignee, priority, labels or description unless the approved action lists it.
- Every provider mutation is a separate action so it can be approved on its own.
