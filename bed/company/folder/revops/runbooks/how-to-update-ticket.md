# How to update a Linear ticket

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every ticket and
comment on this page is invented.

Use the `linear` surface for formal work in team `REVOPS`, project `Q3 close`. Where Linear is,
how it is reached and the service token the automation uses are on the handbook page
`Linear automation`, owned by the work management administrator. Never place the token's value in
an action, skill, fixture, event or ledger row.

The approved transport is Linear's Streamable HTTP MCP endpoint at
`https://mcp.linear.app/mcp`. Treat the URL as connection metadata, not evidence of access: the
surface remains ungranted until the manager and the administrator approve the connection and a
probe succeeds.

Linear's current MCP contract uses `save_comment` for comments and `save_issue` for issue field
changes (there is no `create_comment`). The connection probe must discover those tools before the
surface can become connected.

## Add an audit comment

### Action shape

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "linear",
    "tool": "save_comment",
    "toolArgsJson": "{\"issueId\":\"REVOPS-5\",\"body\":\"Prepared the synthetic close summary for manager review. No customer data was used.\"}"
  }
}
```

- `surface` must match the connected surface slug exactly.
- `issueId` is the issue identifier (`REVOPS-n`) or the provider id, read from the ingested
  candidate or a fresh provider read. Send `issueId` and `body` only.
- `save_comment` also accepts `id` (rewrites an existing comment) and `parentId` (posts a reply).
  An audit comment is a new top-level comment, so never send either.
- `body` states the observable work completed and any values deliberately left unknown.
- Provenance: the shared automation key acts as its human owner in Linear, so every comment ends
  with a trailer naming the employee and the run. The server appends it; a skill never writes one,
  and a trailer a skill wrote is refused.
- Emit one action per comment.

## Change issue status

### Action shape

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "linear",
    "tool": "save_issue",
    "toolArgsJson": "{\"id\":\"REVOPS-5\",\"state\":\"Done\"}"
  }
}
```

- Use `Done` only when the requested effect is complete.
- `id` is the issue identifier or provider id; `state` is the workspace's exact workflow-state name
  discovered from Linear (the argument is `state`, not `status`).
- Do not change assignee, priority, labels or description unless the approved action lists it.

## Discipline

- Work only in team `REVOPS`, project `Q3 close`.
- Take the provider id from the ingested candidate or a fresh provider read.
- Never invent an issue id, project id, state or result.
- Put each provider mutation in its own action so the exact-action gate can approve it separately.
- Summarise the proposed comment and status change in the manager-facing draft.

## Closing the loop

When work originated in Linear, add the audit comment before changing the status, so a status
change is never the only trace of who acted. A partial result gets a comment and remains in
progress. A complete result gets a comment and may move to `Done`. Both actions remain inert until
the manager approves their literal payloads, or the manager has turned autonomous actions on.
