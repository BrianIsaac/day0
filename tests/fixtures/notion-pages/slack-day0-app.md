# Slack automation policy

Slack carries inbound requests and the manager conversation. A reply to a channel ask is posted into that ask's thread as its own action; it is held until the manager approves the exact text, or sent as emitted once the manager has turned autonomous actions on; the manager DM is for questions and escalation.

## Where it is

- Workspace: `day0`.
- Channels: `#revops-asks` (inbound requests), `#revops` (team channel).
- Integration: Slack Web API over HTTPS at `https://slack.com/api/`, bot token in the `Authorization: Bearer` header.
- Methods automations use: `auth.test`, `users.lookupByEmail`, `conversations.open`, `conversations.list`, `conversations.history`, `conversations.replies`, `chat.postMessage`.

## How an automation gets its own Slack identity

Every automation (digital employee) is its own Slack app with its own bot user, so its messages, DM and permissions are its own.

1. The automation registers its app from the team manifest template below, using `apps.manifest.create`. This needs a Slack **app configuration token**, which the messaging administrator issues at approval time (api.slack.com/apps -> Your App Configuration Tokens -> Generate Token, workspace `day0`). Configuration tokens expire after twelve hours and are never kept in documentation.
2. The messaging administrator installs the new app into the workspace from the install link the automation provides. Installation is the approval; the automation receives its bot token through the OAuth redirect and keeps it encrypted.
3. The automation verifies itself with `auth.test`, opens its DM with the manager (`users.lookupByEmail`, `conversations.open`) and joins `#revops-asks` and `#revops` only after the administrator invites it.

Owner: the messaging administrator.

## Manifest template

```json
{
  "display_information": { "name": "<employee name> (Day0)", "description": "RevOps digital employee. Drafts first, sends to the manager, holds public posts." },
  "features": { "bot_user": { "display_name": "<employee name> (Day0)", "always_online": false } },
  "oauth_config": {
    "redirect_urls": ["<Day0 public URL>/api/oauth/slack"],
    "scopes": { "bot": ["chat:write", "channels:read", "channels:history", "im:read", "im:write", "im:history", "users:read", "users:read.email"] }
  },
  "settings": { "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false }
}
```

## Working rules

- The manager DM is opened by looking up the manager's email; automations never guess a channel id.
- A reply to a public channel or thread is emitted as its own `chat.postMessage` action into the source thread (`channel` plus `thread_ts`). While autonomous actions are off it is held for the manager, who approves the exact text before it is sent; once the manager has turned autonomous actions on it is sent as emitted. The manager DM carries questions and escalation, never a draft that belongs in the channel.
- One logical message per action; preserve the originating Linear identifier or Slack thread timestamp in the text.
- If a shared bot token is ever handed over instead of a dedicated app, messages must carry the employee's name and avatar (`chat:write.customize`) so they stay attributable.
