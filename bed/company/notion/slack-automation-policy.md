# Slack automation policy

Kestrel Supply Co. is a synthetic company built for the Day0 demonstration. The channels and
every message in them are invented.

Slack carries requests and the manager conversation. A reply to a channel ask is posted into that ask's thread as its own action; it is held until the manager approves the exact text, or sent as emitted once the manager has turned autonomous actions on for that employee. The manager DM is for questions and escalation.

## Where it is

- Workspace: the company's Slack workspace.
- Integration: Slack Web API over HTTPS at `https://slack.com/api/`, bot token in the `Authorization: Bearer` header.
- Methods automations use: `auth.test`, `users.lookupByEmail`, `conversations.open`, `conversations.list`, `conversations.history`, `conversations.replies`, `chat.postMessage`.

## The channels, by team

| Channel | Team | What it is for |
|---|---|---|
| `#revops-asks` | Revenue operations | requests for revenue operations |
| `#revops` | Revenue operations | the team channel |
| `#finance-close` | Finance close | the team channel, and questions about the close |
| `#logistics-desk` | Logistics desk | shipment exceptions raised by the warehouse and the account team |
| `#ops-requests` | all three teams | the shared request channel; a request belongs to the team whose handbook covers that work |

Each team's handbook names the channels that team reads.

## The shared bot

Every digital employee posts through one shared Slack app, the company automation bot, which is invited to all five channels.

- The shared bot token is landed on each employee's Slack card by the messaging administrator when the connection is approved. It is never written down.
- Each message carries the posting employee's name and icon, so it stays attributable. The app needs `chat:write.customize` for that, beside `chat:write`, `channels:read`, `channels:history`, `im:read`, `im:write`, `im:history`, `users:read` and `users:read.email`.
- The server adds the name, the icon and a provenance trailer to every message; an automation never sets `username`, `icon_emoji` or `icon_url` itself.
- The manager DM is opened by looking up the manager's email; automations never guess a channel id.

Owner: the messaging administrator.

## Working rules

- A reply to a public channel or thread is emitted as its own `chat.postMessage` action into the source thread (`channel` plus `thread_ts`). While autonomous actions are off it is held for the manager, who approves the exact text before it is sent; once the manager has turned autonomous actions on it is sent as emitted. The manager DM carries questions and escalation, never a draft that belongs in the channel.
- One logical message per action; preserve the originating Linear identifier or Slack thread timestamp in the text.
