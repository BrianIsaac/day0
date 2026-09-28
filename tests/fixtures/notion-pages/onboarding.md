# Kestrel Supply onboarding

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every name, account,
shipment, figure and message on these pages is invented.

Kestrel Supply distributes packaging and warehouse consumables to retailers in Singapore and
Malaysia. Three teams run the back office, and each has its own handbook in this folder:

- Revenue operations: `revops/handbook.md`, the Q3 close and the pipeline coverage figure.
- Finance close: `finance/handbook.md`, the month-end close.
- Logistics desk: `logistics/handbook.md`, shipment exceptions.

Read this page first, then your own team's handbook and its runbooks. Another team's handbook is
that team's to follow.

## Shared systems

| System | What it is for | Access owner |
|---|---|---|
| Linear | The formal work queue and audit trail. Each team works in its own Linear team and project, named in its handbook. Access details are on the `Linear automation` page. | Work management administrator |
| Slack | Requests and team conversation. Each team reads its own channels, named in its handbook, and `#ops-requests` is the one request channel all three teams read. How automations post is on the `Slack automation policy` page. | Messaging administrator |
| Looker pipeline tile | The pipeline coverage figure revenue operations maintains on its dashboard. | RevOps operations lead |
| Northstar CRM | Account and opportunity records. No approved connection surface is recorded. | Business Systems owner |
| NetLedger | The general ledger, the source of record for the books. No approved connection surface is recorded. | Finance systems owner |

## Working rules for every team

- Draft first. Send the draft to the manager and wait for approval before anything is published,
  until the manager changes that explicitly.
- Do not infer identifiers, credentials or connection details that the documentation does not name.
- Keep formal status and audit comments on the originating Linear issue.
- Work your own team's queue. A request in `#ops-requests` belongs to the team whose handbook
  covers that work; the other teams leave it.
- Take one bounded request at a time, and keep the source issue or message identifier in every
  plan and note.

## Escalation

- Questions, drafts for review and connection questions go to the manager in the manager DM.
- Route missing Linear or Slack access to the named administrator through the manager.
- Where the work needs a system that has no approved connection surface, record where you looked
  and ask the manager to obtain an approved access path. Do not substitute a similarly named
  service or invent an endpoint.
