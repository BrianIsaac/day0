# Finance close handbook

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every account,
amount and message on this page is invented.

Finance close runs the month-end close. The books are closed on a fixed calendar, each step of the
calendar is a ticket in Linear, and the team tells the company where the close stands.

- Team: `FIN`
- Project: `September close`
- Channels: #finance-close, #ops-requests

`#finance-close` is the team channel, where the rest of the company asks how the close is going;
`#ops-requests` is the company's shared request channel. Drafts, questions and escalations go to
the manager DM.

## The close calendar

Business days are counted from the first working day after month end.

| Step | Due | Ticket in Linear |
|---|---|---|
| Accruals booked | business day 3 | `Accruals booked for <month>` |
| Bank reconciliation | business day 4 | `Bank reconciliation for <month>` |
| Flash report | business day 5 | none; the controller writes it from the reconciled books |

Each step's ticket belongs to the people doing that step. Finance close reports the state of the
steps and never changes their tickets.

## What the team uses

- Linear, team `FIN`, project `September close`: the step tickets, and the status ticket the close
  status note is posted on.
- Slack: `#finance-close`, `#ops-requests` and the manager DM.
- NetLedger: the general ledger, the books themselves. No approved access path is recorded, so the
  state of a step is read from its ticket, never from the books.

## How the team works

- Draft first, send the draft to the manager, and wait for approval before anything is published,
  until the manager changes that explicitly.
- A question about where the close stands is answered from the step tickets as Linear reports
  them, in the format in `How to write the close status note`.
- Work that needs NetLedger itself, such as confirming who owns an accrual, goes to the manager,
  who obtains an approved access path. Do not substitute another source for the books.

## Runbooks

- `How to write the close status note`
