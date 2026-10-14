# How this run was made

Recorded 15 October 2026 (23:39:46 UTC on 14 October) on the disposable compose project
`day0-w18q` (backend `127.0.0.1:6810`, fake Slack `127.0.0.1:6813`), at the v0.22.0 release commit
`fddf16bd3`. `commands.txt` is the driver's own list of the equivalent manual commands; the bed was
brought up with the kit instead, by the 14 October recipe, which still holds on this commit (no
file of the kit or the driver changed since `v0.21.0`):

1. `./setup.sh --route featherless --sandbox local --warm-from day0-redactor-warm --gpu off
   --project day0-w18q --port 6810 --site-port 6811 --dashboard-port 8180 --app-port 6812
   --boss-email manager@acme.test --yes`, the Featherless key in that one process's environment,
   with `DAY0_EVALUATION_BED=revocation`, `FAKE_SLACK_HOST_PORT=6813`,
   `DAY0_TEST_SLACK_API_URL=http://fake-slack:8090/api/` and `DAY0_PRIVATE_HOSTS=looker-tile` in
   `.env.local`: exit 0 in 49 s.
2. The mounted documentation folder (`docs-local/`) holding two pages only, written before the
   setup: `systems/slack.md` (`tests/fixtures/notion-pages/slack-day0-app.md`, its first line set
   to `# Slack`) and `systems/looker-pipeline-tile.md` (`bed/company/folder/systems/looker-pipeline-tile.md`).
3. `pnpm demo:bed up --project day0-w18q` (the checklist's tier 2, the offline rung: GO).
4. `NODE_ENV=development pnpm demo:bed offline-rung --project day0-w18q --out
   evaluation/results/revocation-2026-10-14T23-39-46Z`: exit 0, 23:39:46 to 23:40:13 UTC, the
   first attempt on the first volume.

The kit passes `--out` to the driver as an absolute path, so `commands.txt` named the scratch
directory the clone ran in; its `--out` argument was rewritten to the checkout path and
`SHA256SUMS` taken again over the five files.
