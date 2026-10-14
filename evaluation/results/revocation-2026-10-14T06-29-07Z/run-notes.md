# How this run was made

Recorded 14 October 2026 on the disposable compose project `day0-w17q` (backend `127.0.0.1:5690`,
fake Slack `127.0.0.1:5693`), at commit `c6cc7e6a2`. `commands.txt` is the driver's own list of the
equivalent manual commands; the bed was brought up with the kit instead:

1. `./setup.sh --route featherless --sandbox local --warm-from day0-redactor-warm --gpu off
   --project day0-w17q --port 5690 --site-port 5691 --dashboard-port 7930 --app-port 5692
   --boss-email manager@acme.test --yes`, the Featherless key in that one process's environment,
   with `DAY0_EVALUATION_BED=revocation`, `FAKE_SLACK_HOST_PORT=5693`,
   `DAY0_TEST_SLACK_API_URL=http://fake-slack:8090/api/` and `DAY0_PRIVATE_HOSTS=looker-tile` in
   `.env.local`.
2. The mounted documentation folder (`docs-local/`) holding two pages only:
   `systems/slack.md` (`tests/fixtures/notion-pages/slack-day0-app.md`, its first line set to
   `# Slack`) and `systems/looker-pipeline-tile.md` (`bed/company/folder/systems/looker-pipeline-tile.md`).
3. `pnpm demo:bed up --project day0-w17q` (the checklist's tier 2, the offline rung: GO).
4. `NODE_ENV=development pnpm demo:bed offline-rung --project day0-w17q --out
   evaluation/results/revocation-2026-10-14T06-29-07Z`: exit 0, 06:29:07 to 06:29:40 UTC.

Three attempts before it, none kept:

- 06:23:09, the company pages as the documentation (`./setup.sh ... --company`): the driver did not
  start, since real mode refuses to load under the local profile without `NODE_ENV=development`
  and the kit's rung does not set it.
- 06:23:28, the same volume, with `NODE_ENV=development`: the Slack card ended `listed-dead`
  ("Slack policy does not allow required methods: auth.test, users.lookupByEmail,
  conversations.open"). Approving the trial's charter ran orientation, which proposed the Slack
  and tile cards citing the company's `onboarding.md`, and the driver keeps an existing card's
  evidence; that page names neither the Slack methods nor the tile's probe marker. The run had
  deployed its agent, which spends the volume's trial ids.
- 06:26:00, a fresh volume, the company pages and the Slack page: the tile card ended `ungranted`
  ("No probe marker ... is documented for this browser surface"), for the same reason.

Then a fresh volume with the two pages above, and this run.
