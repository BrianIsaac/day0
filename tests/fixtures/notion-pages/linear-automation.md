# Linear automation

Linear is the team's formal work queue and audit trail. Day0 works only in team `REVOPS`, project `Q3 close`.

## Where it is

- Workspace: `day0`.
- Team: `RevOps`, identifier `REVOPS` (issue ids are `REVOPS-n`).
- Project: `Q3 close`.
- Integration endpoint: Linear's MCP server, Streamable HTTP, `https://mcp.linear.app/mcp`. Authentication is a bearer token in the `Authorization` header.
- Tools the automation is allowed to use: `list_issues`, `get_issue`, `list_comments`, `save_comment`, `save_issue`.

## Access

- Owner: the work management administrator.
- The automation uses a personal API key created for it, scoped to this workspace.
- Service token (RevOps automation): `PASTE_LINEAR_API_KEY_HERE`
- Rotation: create a new key in Linear (Settings -> Security & access -> Personal API keys), replace the line above, revoke the old key.

## Working rules

- The automation key acts as its human owner, so provenance lives in the content: every comment written by an automation ends with a trailer naming the employee and its run id, and a status change is always preceded by such a comment.

- Comments are created with `save_comment`, sending `issueId` (the `REVOPS-n` identifier) and `body` only - never `id` or `parentId`, which rewrite or reply. Comments go on the originating issue.
- Status changes use `save_issue` with `id` and `state`, where `state` is the workspace's exact workflow state name (`Todo`, `In Progress`, `Done`).
- Do not change assignee, priority, labels or description unless the approved action lists it.
- Every provider mutation is a separate action so it can be approved on its own.
