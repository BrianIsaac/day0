# The Slack asks, posted by hand

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration; these asks are
invented.

The operator posts these asks by hand, as a person in the company would, in this order and at the
run protocol's step 0:16, once every employee's Slack card is connected. They are not posted by a
script: intake skips the shared bot's own messages, so an ask the bot posted would never reach
anyone.

Each ask mentions the shared bot. Type `@` and pick the bot by its Slack name, so Slack turns the
mention into the bot's id; intake reads only messages that mention it.

| Order | Channel | Text | Whose work |
|---|---|---|---|
| 1 | `#revops-asks` | @bot can you confirm pipeline coverage for the three Friday standup deals before the Q3 close summary goes out? | revenue operations |
| 2 | `#finance-close` | @bot can you post where the September close stands? | finance close |
| 3 | `#ops-requests` | @bot please refresh the pipeline tile to the standup figure | revenue operations; finance close and the logistics desk see it too and leave it |

Post nothing else in these five channels during the run. An ask left over from an earlier run is
read again by a new deployment, because the first poll of a channel reads its whole history:
delete your earlier asks by hand before the run. `pnpm bed:company check` lists every message
that mentions the bot and was not posted by it.
