# How to refresh the Looker pipeline tile

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. The tile, its figure
and its login are invented.

Use the `looker-pipeline-tile` surface for the pipeline coverage figure on the tile. This system
has a web UI only: there is no API, MCP server or export endpoint. Its internal address on the
Day0 Compose network is `http://looker-tile:8080/`, and the anonymous page has the documented
probe marker `Sign in - Looker`.

Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`), held by the RevOps
operations lead and rotated each quarter. Documentation sync encrypts the value and replaces it on
the stored page with a credential marker. Never put the literal password in a skill, action,
prompt, event, screenshot or ledger row.

For this close, the Friday standup coverage summary is the approved source and states **74%**.
Enter `74%` exactly; do not calculate a replacement figure from another source.

Drive the page with the connected surface's allowlisted `browser.*` verbs. One run receives one
isolated browser session, so the sign-in and save sequence remains in the same tab and no other run
inherits its cookies. The skill emits human-readable element names; the adapter takes a fresh
accessibility snapshot and resolves the pinned driver's live element reference immediately before
each form or click.

## Action shapes

Open the documented page:

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "looker-pipeline-tile",
    "tool": "browser_navigate",
    "toolArgsJson": "{\"url\":\"http://looker-tile:8080/\"}"
  }
}
```

Fill the login form. `{{secret}}` is the only permitted route for the decrypted login and is
replaced inside the browser adapter immediately before the driver call:

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "looker-pipeline-tile",
    "tool": "browser_fill_form",
    "toolArgsJson": "{\"fields\":[{\"name\":\"Username\",\"value\":\"revops\"},{\"name\":\"Password\",\"value\":\"{{secret}}\"}]}"
  }
}
```

Submit the login:

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "looker-pipeline-tile",
    "tool": "browser_click",
    "toolArgsJson": "{\"element\":\"Sign in\"}"
  }
}
```

Fill the one editable value, then save it:

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "looker-pipeline-tile",
    "tool": "browser_fill_form",
    "toolArgsJson": "{\"fields\":[{\"name\":\"Pipeline coverage\",\"value\":\"74%\"}]}"
  }
}
```

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "looker-pipeline-tile",
    "tool": "browser_click",
    "toolArgsJson": "{\"element\":\"Save\"}"
  }
}
```

Read the result in the same session:

```json
{
  "tool": "mcp.call",
  "args": {
    "surface": "looker-pipeline-tile",
    "tool": "browser_snapshot",
    "toolArgsJson": "{}"
  }
}
```

The evidence is the audit line beneath the tile: `Last updated by <user> at <time> UTC`. Quote that
line and the visible figure in the completion note. A successful click without that read-back is
not evidence that the change landed.

## Discipline

- Keep navigation on `http://looker-tile:8080/`; a redirect to another origin is a refusal.
- Use only `Username`, `Password`, `Sign in`, `Pipeline coverage` and `Save` as element names. Do not
  invent driver references; they are session-local and resolved at execution time.
- Emit the full sequence even while autonomous actions are off. Because a browser login cannot be
  split across sessions, any held write parks the whole browser sequence for exact-action approval.
- With autonomous actions on, the same emitted actions run immediately; the switch changes timing,
  never payloads.
- Never take a screenshot, evaluate page code, upload a file, open an arbitrary tab or navigate to
  another system. Those verbs are outside the browser floor and must remain unavailable.
- If the page redirects, the login fails, an element is absent, or the audit line does not appear,
  record the observed failure as data and stop. Do not retry indefinitely or claim success.
