# How to write the close status note

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every ticket, amount
and message on this page is invented.

The close status note tells the company where the month-end close stands. It is one comment on
the status ticket in Linear team `FIN`, project `September close`: the ticket titled
`Post the <month> close status note`.

## Format

One comment, in this order:

1. One line for each calendar step that has a ticket, in calendar order: the step, its ticket's
   identifier and title, and its state exactly as Linear reports it.
2. One line naming what is not done yet: every step whose ticket is not at `Done`, or `nothing`
   when all of them are.

The flash report has no ticket and is not in the note; the controller reports it on business day 5.

```text
Accruals booked: <identifier> <title>, <state>
Bank reconciliation: <identifier> <title>, <state>
Not done yet: <each step not at Done, or nothing>
```

## Rules

- Read each step's state from its ticket in Linear when writing the note. Do not infer a state from
  a message, a date or the calendar.
- The step tickets are never changed: no comment, no state change, no assignment.
- The note is the deliverable. Once the comment is posted, move the status ticket to `Done`.
- A question in `#finance-close` about where the close stands is answered in its thread with the
  same lines as the note.
