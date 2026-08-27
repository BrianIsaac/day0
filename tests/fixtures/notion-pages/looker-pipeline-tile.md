# Looker pipeline tile

The pipeline coverage tile on the RevOps Looker dashboard is the number quoted in the Friday
standup and in the Q3 close summary. It is maintained by hand.

## Where it is

- The Looker pipeline tile is reached through its web UI only, at `http://looker-tile:8080/`. That
  is the demo's internal address on the Day0 compose network; in a real deployment it is the
  dashboard's own URL.
- Probe marker: page title `Pipeline coverage - Looker`.
- Integration: none. There is no API, no MCP server and no export endpoint for this dashboard.
  Automations reach it the way a person does, through the browser.
- Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`), held by the RevOps
  operations lead and rotated each quarter.

Owner: the RevOps operations lead.

## Working rules

- Sign in on the page, update the pipeline coverage figure, and press Save.
- The audit line under the tile is the evidence the change landed: it reads
  `Last updated by <user> at <time> UTC`. Read it back after saving and quote it when reporting the
  change. Do not report a figure as updated without it.
- One figure per visit. The tile holds a single value; there is nothing else on the page to change.
- Never take a screenshot of the dashboard into a ticket or a message. Quote the figure and the
  audit line instead.
- If the page cannot be reached or the login is refused, say so and ask the operations lead. Do not
  look for another route into the dashboard - there is not one.
