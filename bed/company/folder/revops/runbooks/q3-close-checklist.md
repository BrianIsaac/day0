# Q3 close checklist

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every value on this
page is invented.

The quarter-end close for revenue operations is three checks. This page is the source for the
close-summary audit note: the note quotes these checks and the evidence each one leaves, and
nothing else.

## The three checks

1. **Pipeline coverage confirmed.** The pipeline coverage figure on the Looker pipeline tile matches
   the Friday standup coverage summary. This check includes the refresh: if the tile does not already
   show the approved figure with an audit line from this close, refresh it first by the sequence in
   `How to refresh the Looker pipeline tile`, in the same browser session, and only then read it back.
   Evidence: the visible figure on the tile and its audit line, `Last updated by <user> at <time> UTC`,
   quoted exactly after the refresh. The approved figure for this close is on the standup summary and
   in the tile runbook; do not compute it from the tile itself.
2. **Friday standup deals reconciled.** The three deals named in the Friday standup are present in
   the Q4 pipeline tracker with their stage and forecast amount. Evidence: the tracker rows for the
   three deals, named by account.
3. **Close tickets at Done.** Every `Q3 close` project ticket in Linear team `REVOPS` is at `Done`,
   except the audit-note ticket itself, which closes last. Evidence: the ticket identifiers and their
   state as Linear reports them.

## Writing the close-summary audit note

- The note is one comment on the audit-note ticket, in this order: the three checks, each with its
  evidence as read from the system that holds it; then one line naming anything not confirmed.
- Quote evidence; do not restate it. A figure comes from the tile's audit line, a deal from the
  tracker row, a state from Linear.
- A check whose evidence cannot be read is reported as not confirmed, with the reason. The note is
  still posted; the ticket moves to `Done` only when all three are confirmed or the manager says so.
- Northstar CRM plays no part in the close checks. A request that needs it goes to the manager.

## Owner

The revenue operations manager owns this checklist and the close. Questions about a check that the
evidence does not settle go to the manager DM, not to the ticket.
