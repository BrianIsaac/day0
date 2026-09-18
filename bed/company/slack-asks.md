# The Slack asks, posted once by a person and left standing

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration; these asks are
invented.

The asks come from a person. The operator posts them once, as themselves, the way someone in the
company would, and leaves them standing in the channels. They are never posted through the shared
bot's token, by a script or under a borrowed display name: intake never reads anything the app
itself posted, under any name, so an ask sent that way reaches nobody.

Each ask mentions the shared bot. Type `@` and pick the bot by its Slack name, so Slack turns the
mention into the bot's id; intake reads only messages that mention it.

| Order | Channel | Text | Whose work | Sittings |
|---|---|---|---|---|
| 1 | `#revops-asks` | @bot can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out? | revenue operations | `full` |
| 2 | `#finance-close` | @bot can you post where the September close stands? | finance close | `full` |
| 3 | `#ops-requests` | @bot please refresh the pipeline tile to the standup figure | revenue operations; finance close and the logistics desk see it too and leave it | `full`, `one-each` |

The last column is read by `pnpm bed:company check`: it names the sittings an ask stands for.

## The full run: all three stand

- **Every new full-run deployment reads them by itself.** The first poll of a channel reads its
  whole history, so a fresh bed takes up all three on its first poll, as soon as each employee's
  Slack card is connected. Nobody posts anything before a run.
- **Teardown leaves them alone.** `pnpm bed:company teardown` deletes only what the app posted
  with a provenance trailer, which is the employees' replies under the asks. The asks are a
  person's messages and stay.
- **`pnpm bed:company check` expects all three.** It names each standing ask with its channel
  and first words and says whether all three are present. A missing one, a second copy of one,
  or any other message that mentions the bot is a gap.

## The one-task-each demo sitting: only ask 3 stands

The demo sitting (`--set one-each`) is one task per employee. Revenue operations' task is ask 3,
the `#ops-requests` ask, in place of the `revops-tile` Linear ticket, which that set does not
file: the camera sees a Slack ask claimed by one employee, left at scope by the other two, and
answered in its thread. Finance close and the logistics desk each work their Linear ticket.
`pnpm bed:company seed --set one-each` still restarts the Looker pipeline tile at its starting
figure; that reset belongs to the seed, not to any ticket.

- **Before a demo sitting, delete asks 1 and 2 by hand** (`#revops-asks` and `#finance-close`).
  Left standing, each would add an item on camera. Keep ask 3.
- **`pnpm bed:company check --set one-each` expects exactly ask 3.** Its absence is a gap, and
  any other standing message that mentions the bot, in `#revops-asks`, `#finance-close` or any
  other bed channel, is a gap naming its channel and text.
- **For the next full run, post asks 1 and 2 again**, once, as yourself. `pnpm bed:company check`
  then finds all three.

Post nothing else that mentions the bot in these five channels: a new deployment would read it as
work.
