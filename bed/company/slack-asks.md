# The Slack asks, posted by a person during each sitting

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration; these asks are
invented.

The asks come from a person. The operator posts them during the sitting, as themselves, the way
someone in the company would, once the three employees are deployed: a deployment takes no mention
written before its agent was deployed, so an ask posted earlier is never read. They are never
posted through the shared bot's token, by a script or under a borrowed display name: intake never
reads anything the app itself posted, under any name, so an ask sent that way reaches nobody.

Each ask mentions the shared bot. Type `@` and pick the bot by its Slack name, so Slack turns the
mention into the bot's id; intake reads only messages that mention it.

| Order | Channel | Text | Whose work | Sittings |
|---|---|---|---|---|
| 1 | `#revops-asks` | @bot can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out? | revenue operations | `full` |
| 2 | `#finance-close` | @bot can you post where the September close stands? | finance close | `full` |
| 3 | `#ops-requests` | @bot please refresh the pipeline tile to the standup figure | revenue operations; finance close and the logistics desk see it too and leave it | `full`, `one-each` |

The last column is read by `pnpm bed:company check`: it names the sittings that post an ask.

## The full run: all three

- **Post all three once the employees are deployed.** Each employee's first poll of a channel
  reads from the moment it was deployed, so an ask posted after the deploy is taken up as soon as
  that employee's Slack card is connected.
- **Teardown leaves them alone.** `pnpm bed:company teardown` deletes only what the app posted
  with a provenance trailer, which is the employees' replies under the asks. The asks are a
  person's messages and stay; the next sitting's employees never read them.
- **`pnpm bed:company check` names each ask to post** with its channel and text. An ask or any
  other mention left from an earlier sitting is not a gap: no new deployment reads it.

## The one-task-each demo sitting: only ask 3

The demo sitting (`--set one-each`) is one task per employee. Revenue operations' task is ask 3,
the `#ops-requests` ask, in place of the `revops-tile` Linear ticket, which that set does not
file: the camera sees a Slack ask claimed by one employee, left at scope by the other two, and
answered in its thread. Finance close and the logistics desk each work their Linear ticket.
`pnpm bed:company seed --set one-each` still restarts the Looker pipeline tile at its starting
figure; that reset belongs to the seed, not to any ticket.

- **Post only ask 3**, once the employees are deployed. Asks 1 and 2 are not posted in this
  sitting; their copies from an earlier sitting stay where they are, unread by any bed deployed
  after them. A bed restored from a snapshot is the exception: it resumes from the snapshot's last
  poll, so it reads every mention posted since, and asks left from a later sitting become work
  for it.
- **`pnpm bed:company check --set one-each` names only ask 3.**

During a sitting, post nothing else that mentions the bot in these five channels: every employee
deployed before it would read it as work.
