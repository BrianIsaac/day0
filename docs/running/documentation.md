# Writing documentation day0 acts on

This page is for the person who writes the team's handbook: the pages day0 reads before it does
any work. day0 reads ordinary Markdown, and most of a page is read as context. A few shapes are
read as instructions: they decide which systems an employee is offered, how it connects to each,
which credential it may bind, which queue it reads, and which pages it treats as procedures. This
page lists those shapes. Every example below is run through the code that reads it by
`tests/src/docs/author-guide.test.ts`, so an example that stops working fails the gate.

## Which pages are read

- A folder or git source reads every `.md` file under it. Other files, images included, are
  skipped.
- A page's title is its first `# ` heading, or its file name when it has none.
- Each linked source is read again on a schedule. A change reaches day0 at the next sync, not when
  you save.

## Naming a system

A system is something an employee may be given access to: a ticket tracker, a chat workspace, a
dashboard. day0 finds systems in two places, and nowhere else by rule:

- A table whose first header cell is `System`, `Product`, `Service` or `Tool`. The first cell of
  each row is the system's name.
- A page under a `systems/` directory. Its `# ` heading is the system's name.

<!-- example: systems-table -->

```markdown
## Shared systems

| System        | What it is for         | Access owner                  |
| ------------- | ---------------------- | ----------------------------- |
| Linear        | The team's work queue. | Work management administrator |
| Northstar CRM | Account records.       | Business Systems owner        |
```

A system the charter names but no page names is recorded as having no documented way in. When a
page later names it, or a page that denied it stops denying it, the next sync orients it again:
you do not need to ask the manager to re-run anything.

## Saying how a system is reached

An address belongs to a system when the sentence it sits in names the system, or when the
address's host carries the system's name. Put each address in a sentence that names its system.

<!-- example: endpoint-sentence -->

```markdown
# Linear automation

Linear's MCP endpoint is https://mcp.linear.app/mcp.
```

- An MCP endpoint must be `https`. A host inside your own network is admitted only when the
  operator lists it in `DAY0_PRIVATE_HOSTS`; otherwise the card names the endpoint and says why
  it was not used.
- A sentence that says there is no API, no MCP server, no approved connection or that something
  is not approved is a denial. Its addresses are never used, and a system whose pages only deny
  it is recorded as having no way in.

<!-- example: denial -->

```markdown
# Northstar CRM

No approved API or MCP server is recorded for Northstar CRM.
```

- For a system reached through its web page, write the page title day0 should see after it opens
  the page, so it can tell it reached the right one.

<!-- example: probe-marker -->

```markdown
Probe marker: page title `Pipeline coverage`
```

## Writing a credential on a page

A credential written on a page is removed from every copy day0 keeps and stored encrypted; the
employee binds it by its label. Write the label, a colon, and the value in backticks.

<!-- example: credential -->

```markdown
- Dashboard login (Looker tile): `pipeline-tile-local`
```

- Quote the value. An unquoted value is taken only when it cannot be prose: a plain word
  (`Password: Summer`), the first word of a phrase (`Login: Google Workspace SSO`) and any
  Chinese, Japanese or Korean text after the label (`密码：请联系IT管理员`) are left alone.
- `login: user / password` stores the second half only.
- A sample in a provider's token format (`lin_api_XXXXXXXXXXXX`) is not a credential and is not
  stored.
- If the same login is written on the system's own page and on a runbook, the system's page is
  the one bound. Write it once, on the system's page.

<!-- example: prose-login -->

```markdown
- Login: Google Workspace SSO
- Password: Managed by Okta
```

## Naming the queue an employee reads

An employee reads only the queue its card was approved for, and the card offers what the pages
state on these lines. Values go in backticks, channels start with `#`.

<!-- example: queue -->

```markdown
- Team: `FIN`
- Project: `September close`
- Channels: #finance-close, #ops-requests
```

- A line that says not to use, read, poll, work or monitor something states nothing, whatever it
  names.
- Renaming or moving the page, reflowing the line or adding a channel to it keeps an approved
  card connected, as long as the approved value is still stated on a page of the same source.
  Removing an approved value from every page returns the card to the manager for approval.
- A card is tied to one team's handbook by the employee's role: keep each team's pages under a
  directory named for the team, with its handbook at the top.

## Procedures and context

A page is a procedure (a how-to) when it sits under a `runbooks/`, `how-to/` or `playbooks/`
directory, or when its title or first heading says "how to", "runbook" or "playbook". A procedure
is given to the employee as the format of the actions it takes; every other page is read-only
context.

<!-- example: procedure -->

```markdown
# Q3 close checklist

1. Read the pipeline tile.
2. Post the figure in the close thread.
```

The example above is a procedure when it is saved as `revops/runbooks/q3-close-checklist.md`, and
context when it is saved as `revops/q3-close-checklist.md`.

## The Slack app manifest

When the chat workspace is Slack, the first fenced JSON block on a page that has both
`redirect_urls` and `scopes.bot` is the app manifest day0 asks the administrator to install.

<!-- example: manifest -->

```json
{
  "display_information": { "name": "<employee name>" },
  "oauth_config": {
    "redirect_urls": ["<Day0 public URL>/api/oauth/slack"],
    "scopes": { "bot": ["chat:write", "channels:history"] }
  }
}
```
