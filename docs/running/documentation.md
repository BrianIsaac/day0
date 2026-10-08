# Writing documentation day0 acts on

This page is for the person who writes the team's handbook: the pages day0 reads before it does
any work. day0 reads ordinary Markdown, and most of a page is read as context. A few shapes are
read as instructions: they decide which systems an employee is offered, how it connects to each,
which credential it may bind, which queue it reads, and which pages it treats as procedures. This
page lists those shapes. The examples below are run through the code that reads them by
`tests/src/docs/author-guide.test.ts`, so an example that stops working fails the gate; the
documented-API example is checked that way once day0 reads that grammar.

## Which pages are read

- A folder or git source reads every `.md` file under it. Other files, images included, are
  skipped.
- A git source is a repository on GitHub or GitLab. IT can add other public code hosts in
  `DAY0_GIT_HOSTS` (for example `gitee.com`, the JiHu host `jihulab.com`, or the company's own),
  and hosts inside the company's network in `DAY0_PRIVATE_HOSTS`. A repository on any other host
  is refused. Listing a host in `DAY0_GIT_HOSTS` does not make it a private host: a host listed
  there must resolve to a public address, and one that resolves inside the network is refused
  until it is listed in `DAY0_PRIVATE_HOSTS` instead.
- A repository on a host other than GitHub or GitLab is cloned, which needs a `git` binary in
  the backend. The backend image an install builds carries one (`docker/backend.Dockerfile`);
  on an image someone replaces with one that has none, the source's status says so.
- A Feishu or Lark source reads a wiki space, or a Drive folder and the folders under it, as the
  company's own app: every new-style document as Markdown, and every sheet, base, mind note or
  file named as not read. How IT sets up the app, and what each refusal means:
  [reader-feishu.md](reader-feishu.md).
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

- When the page needs a login, also name one element the page shows only once you are signed in,
  and write the account name beside the login's credential. day0 then signs in with the
  credential when it checks the connection, and looks for that element: a password that was
  rotated, or a login page that was redesigned, leaves the system unconnected with a card that
  says so, instead of being found by the first piece of work.

<!-- example: probe-signed-in -->

```markdown
- Probe marker: page title `Sign in - Looker`.
- Probe marker: after sign-in, element `Pipeline coverage`.
- Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`)
```

- The element is named as the page names it to a screen reader: a heading, a field or a button's
  label. Any element with that name will do. It must be on the page the login lands on: day0
  presses nothing after `Sign in`, so an element behind a "stay signed in" question or a menu is
  not found.
- day0 types the account name into the field labelled for it (`Username`, `User name`, `Email`)
  and the credential only into the field labelled for it (`Password`, `Passcode`, `Access code`,
  `API key`, `Token`), then presses the page's `Sign in` (or `Log in`) control. A login that asks
  for the account on one page and the password on the next is followed through its `Next`
  control. Nothing else on the page is clicked.
- A page with only a title marker is checked by its title. day0 does not sign in to it, so a
  rotated password is found by the first piece of work that signs in.
- A single sign-on or a second factor cannot be completed by day0; a page that sends the login to
  another address is left unconnected.

## A documented API that is not Slack

When a system is reached through its own HTTP API rather than an MCP server or Slack, the page
names the API's base address in a sentence that names the system, the operations the employee may
call, the one read day0 checks the key with, and the header the key goes in. day0 checks the key
with that read before the connection is used, and the operations you list are the only ones the
employee may call.

<!-- example: api-operations -->

```markdown
# Tracker API

The Tracker API base is https://tracker.example.com/api/v2/.

- `GET /issues` lists the open issues.
- `POST /comments` adds a comment to an issue.
- `GET /issues/{id}` reads one issue.
- Send the key as `X-Api-Key: {{secret}}`.
- Probe read: `GET /me`
```

- An operation is a verb (`GET`, `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`) and a path in
  backticks, written from the base (`GET /issues`) or as a full address under it
  (`GET https://tracker.example.com/api/v2/projects`). A query string is ignored.
- The verb is part of the operation. Documenting `GET /issues` lets the employee list issues and
  nothing else at that path: a `DELETE /issues` or a `PATCH /issues` is refused. Document each
  verb the employee may use.
- A path segment that stands for a value is written `{id}` (`:id` and `<id>` are read the same
  way). It matches any one segment of a request: `GET /issues/{id}` admits `GET /issues/ENG-12`,
  but not `GET /issues/ENG-12/comments`, which needs its own line. A placeholder must be a whole
  segment; `/issues/{id}.json` matches nothing.
- The key's header is the first header in backticks that carries `{{secret}}`
  (`X-Api-Key: {{secret}}`, `Authorization: Token {{secret}}`), or an `Authorization` header
  with a scheme (`Authorization: Bearer`). A page that shows neither gets a bearer token. The key
  goes only in a header: a request that puts `{{secret}}` in its body or its path is refused, so
  a key can never be posted as a comment.
- The probe read is the one request day0 sends, with the key, when it checks the connection:
  on approval and every hour after. Write it on its own line, `Probe read:` and a `GET` in
  backticks, and pick a request that changes nothing, such as the API's "who am I" call. It must
  be a plain path under the base with no `{id}` segment. day0 never guesses one from your list,
  because a `GET` can change things (`GET /auth/logout`); a page with no probe read leaves the
  system unconnected with a card that says so. The probe read is also callable by the employee.
- day0 does not follow a redirect with the key, and a page with no operation leaves the system
  unconnected; both are day0's limitation, not evidence that the system is unavailable.
- The base address follows the same rule as an MCP endpoint: public `https`, or a host the
  operator lists in `DAY0_PRIVATE_HOSTS`. The address is checked again on every request, not only
  when the connection is checked, so a name that later points somewhere private is refused.
- A rate limit (`429`) or a server error when the key is checked is tried again later, after the
  wait the API asks for; it never marks the system unavailable on its own.
- Only the system's own pages are read for its operations. An operation written on another
  system's page is not admitted for this one.
- A chat system is the exception. day0 reads chat over a documented API only through Slack's Web
  API, so a chat system other than Slack (Microsoft Teams, Feishu) is not connected on this path,
  however well its page documents the API. Its card says so. Document it anyway: the page is what
  a chat reader for it will read.

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
- Reflowing the line or adding a channel to it keeps an approved card connected. So does
  renaming or moving the page within the team's directory, or anywhere when the new page states
  every value of an approved queue of two or more. A one-value queue moves only within the team's
  directory, since any page naming that value would state it whole. Removing an approved value
  from its page returns the card to the manager for approval, even when another team's page names
  the same value.
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
