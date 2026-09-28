# Test fixtures

What the recorded fixtures under this directory carry, and the one rule that
edits them (decision N15, 27 September 2026).

## The identifiers are the operator's synthetic workspaces

The Slack team, channel and user ids (`T0BSQSQG0UU`, `C0C2P932A2H`,
`C0C2U2UJUTU`, `U0BTFK6FLNL`, `U0BTFHN6MKJ` and their kin), the Linear
workspace `day00` with its issue, project, team and creator uuids, and the
Notion page ids under `tests/` (these recordings and the tests that replay
them) are the addresses of workspaces the operator created for Day0's own
runs. They hold no customer, no colleague and no
credential: every account, ticket, message and figure in them is invented,
and the workspaces are the ones the README's real-mode walkthrough and the
company bed (`bed/company/`) describe. They are kept as recorded because a
recording with its addresses rewritten is a recording of nothing, and the
tests that replay these runs match on them.

## The one substitution

Two things are replaced in every recording, by `pnpm fixtures:substitute`
(`scripts/fixture-substitution.ts`) and never by hand:

- the manager's Slack DM channel id, which becomes `D0MANAGER`;
- the operator's name as manager or requester, which becomes `Sam`
  (`Sam Ortiz`, `sam.ortiz`, and `sam/` as a git branch prefix, where a
  recording carried the full name, a handle, a branch, or the branch prefix
  Linear builds from the operator's account name), under decision N6: the
  product carries no real person's name.

The rule runs over every text file under `tests/`, not only this directory;
the lower-case first-name rule runs under `tests/fixtures/` only, because its
word is an English one elsewhere. `pnpm fixtures:substitute --check` fails
naming any file the rule would still change, and
`tests/scripts/fixture-substitution.test.ts` runs that check over the tracked
tree. Two paths are excluded: the redaction corpus (`redaction/`), whose span
model recording is keyed by character offset and cannot be retaken without
the redactor component, so its sample person keeps the name it was recorded
with; and the rule's own test, which carries the names it replaces by design.

The evaluation results under `evaluation/results/` are outside the rule's
root: they are frozen evidence, and no rule rewrites them. They carry no
machine path either (the three that did were made relative by hand, once); a re-grade records its source from the checkout root
(`evaluation/results/<run>/<file>.json`), and a test holds every committed
result to that.

## Provenance

A recording named for a day (`*-2026-09-19.ts`) carries the day of the run
or the export it comes from. Where a fixture states its provenance, in a
header or, for a JSON recording, in a `provenance` or `source` key, it says
which run it is, whether its strings are verbatim or reconstructed, and the
model where the run's record names it. The runs' exports and findings files
are private recordings kept outside the tree; no header cites a path a reader
of this repository cannot open. Where a fixture was reconstructed from a run
record rather than read from an export, the header says so.

## The handbook twins

`notion-pages/` holds the documentation pages the orientation and sync tests
read. Four are the company bed's own pages byte for byte, and
`tests/bed/company-docs.test.ts` fails while a copy is stale:

| Twin | Source |
|---|---|
| `onboarding.md` | `bed/company/folder/onboarding.md` |
| `looker-pipeline-tile.md` | `bed/company/folder/systems/looker-pipeline-tile.md` |
| `northstar-crm.md` | `bed/company/folder/systems/northstar-crm.md` |
| `linear-automation.md` | `bed/company/notion/linear-automation.md` |

`slack-day0-app.md` is the Slack automation policy page of the operator's
September 2026 Notion workspace, a private recording: it carries the app
manifest the Slack provisioning tests read, which the bed's Slack page
(`bed/company/notion/slack-automation-policy.md`) does not yet carry.

`company-bed/` is the whole bed copied byte for byte, guarded by the same
test.
