# How to post to Slack

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. Every channel and
message on this page is invented.

Use the `slack` surface for `#revops-asks`, `#revops`, the shared `#ops-requests` channel and the
manager DM. Where the workspace is, which channels exist and how automations post are on the
handbook page `Slack automation policy`, owned by the messaging administrator. The shared bot
token is landed on your Slack card by the messaging administrator when the connection is
approved, and is never written down. Never include it in an action, draft, fixture, event or
ledger row.

The approved transport is the Slack Web API over HTTPS at `https://slack.com/api/` with the bot
token as a bearer. The surface remains ungranted until the manager and the administrator approve
the connection and a probe (`auth.test`) succeeds. The probe also opens the manager DM by looking
up the manager's email (`users.lookupByEmail`, `conversations.open`) and records the channel id
on the surface; the automation never guesses it.

A public-channel post or thread reply is emitted like any other action. While the manager's
autonomous-actions switch is off it is held for the manager, who approves the exact text before it
reaches Slack; once the switch is on it is sent as emitted. A reply to an ask belongs in that ask's
thread: set `channel` to the source channel and `thread_ts` to the source message timestamp.

## Action shape

```json
{
  "tool": "http.request",
  "args": {
    "surface": "slack",
    "method": "POST",
    "path": "/chat.postMessage",
    "headersJson": "{\"Authorization\":\"Bearer {{secret}}\",\"Content-Type\":\"application/json; charset=utf-8\"}",
    "body": "{\"channel\":\"D0123456789\",\"text\":\"Draft complete: the synthetic close summary is ready for your review.\"}"
  }
}
```

- `surface` must match the connected surface slug exactly.
- `channel` is the manager DM id read from the connected surface, not a display name.
- Never set `username`, `icon_emoji` or `icon_url`. On the shared bot the server adds the
  employee's own name and icon to every message, and a message that sets them itself is refused.
- `text` is the literal message the manager approves.
- `thread_ts` may be added to the body only when replying to a known thread.
- `{{secret}}` is replaced server-side with the surface's credential; the literal token never
  appears anywhere.

## Discipline

- Send one logical message per action.
- Whether the manager's autonomous-actions switch is on or off does not change what you emit:
  write every message as it should land.
- Preserve the originating Linear slug or Slack message timestamp in the message when relevant.
- Never invent a channel id, user id, thread timestamp or delivery result.
- A public destination is held while autonomous actions are off even if a runbook asks for a
  channel acknowledgement.

## Closing the loop on a public-channel ask

Emit the reply as a `chat.postMessage` action into the originating thread (`channel` and
`thread_ts` from the reply target). It is held for the manager, who approves the exact text,
unless autonomous actions are on. Send a manager DM only for a question or an escalation, never
to carry the reply text.
