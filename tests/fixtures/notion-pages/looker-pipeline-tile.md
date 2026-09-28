# Looker pipeline tile

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. The tile, its figure
and its login are invented.

The Looker pipeline tile holds the single pipeline coverage figure revenue operations maintains
by hand. The figure is quoted in the Friday standup and in the Q3 close summary.

## Where it is

- The Looker pipeline tile is reached through its web UI only, at `http://looker-tile:8080/`. That
  is the demo's internal address on the Day0 compose network; in a real deployment it is the
  dashboard's own URL.
- Probe marker: page title `Sign in - Looker`.
- Integration: none. There is no API, no MCP server and no export endpoint for this dashboard.
  Automations reach it the way a person does, through the browser.
- Dashboard login (Looker tile): `pipeline-tile-local` (username `revops`), held by the RevOps
  operations lead and rotated each quarter.

Owner: the RevOps operations lead.

## Current approved figure

For this close, the Friday standup coverage summary states **74%**. That summary is the approved
source for the refresh; enter `74%` exactly and preserve the tile's audit line as proof.

## Working rules

- Sign in on the page, update the pipeline coverage figure, and press Save.
- The audit line under the tile is the evidence the change landed: it reads
  `Last updated by <user> at <time> UTC`. Read it back after saving and quote it when reporting the
  change. Do not report a figure as updated without it.
- One figure per visit. The tile holds a single value; there is nothing else on the page to change.
- Never take a screenshot of the dashboard into a ticket or a message. Quote the figure and the
  audit line instead.
- If the page cannot be reached or the login is refused, say so and ask the operations lead. Do not
  look for another route into the dashboard; there is not one.
