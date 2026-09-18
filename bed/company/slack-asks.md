# The Slack asks, posted once by a person and left standing

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration; these asks are
invented.

The asks come from a person. The operator posts them once, as themselves, the way someone in the
company would, and leaves them standing in the channels. They are never posted through the shared
bot's token, by a script or under a borrowed display name: intake never reads anything the app
itself posted, under any name, so an ask sent that way reaches nobody.

Each ask mentions the shared bot. Type `@` and pick the bot by its Slack name, so Slack turns the
mention into the bot's id; intake reads only messages that mention it.

| Order | Channel | Text | Whose work |
|---|---|---|---|
| 1 | `#revops-asks` | @bot can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out? | revenue operations |
| 2 | `#finance-close` | @bot can you post where the September close stands? | finance close |
| 3 | `#ops-requests` | @bot please refresh the pipeline tile to the standup figure | revenue operations; finance close and the logistics desk see it too and leave it |

How the standing asks behave:

- **Every new full-run deployment reads them by itself.** The first poll of a channel reads its
  whole history, so a fresh bed takes up all three on its first poll, as soon as each employee's
  Slack card is connected. Nobody posts anything before a run.
- **Teardown leaves them alone.** `pnpm bed:company teardown` deletes only what the app posted
  with a provenance trailer, which is the employees' replies under the asks. The asks are a
  person's messages and stay.
- **`pnpm bed:company check` reports them.** For the full run it names each standing ask with its
  channel and first words, says whether all three are present, and reports a missing one, a
  second copy of one, or any other message that mentions the bot as a gap.
- **Delete them by hand only before a one-task-each demo sitting.** That sitting is one task per
  employee, and a standing ask would add items on camera. `pnpm bed:company check --set one-each`
  reports every standing message that mentions the bot as a gap, naming its channel and text.
  Post the three asks again, once, after the sitting.

Post nothing else that mentions the bot in these five channels: a new deployment would read it as
work.
