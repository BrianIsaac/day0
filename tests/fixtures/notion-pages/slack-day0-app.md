# Slack automation policy

Slack carries inbound requests and the manager conversation. During cold start the manager DM is the only permitted outbound destination.

## Where it is

- Workspace: `day0`.
- Channels: `#revops-asks` and `#revops`.
- Integration: Slack Web API over HTTPS at `https://slack.com/api/`, bot token in the `Authorization: Bearer` header.
- Methods automations use: `auth.test`, `users.lookupByEmail`, `conversations.open`, `conversations.list`, `conversations.history`, `conversations.replies`, `chat.postMessage`.

## How an automation gets its own Slack identity

1. The automation registers its app from the team manifest template using `apps.manifest.create`. This needs a Slack app configuration token, which the messaging administrator issues at approval time. Configuration tokens expire after twelve hours and are never kept in documentation.
2. The messaging administrator installs the new app into the workspace from the install link the automation provides. Installation is the approval; the automation receives its bot token through the OAuth redirect and keeps it encrypted.
3. The automation verifies itself with `auth.test`, opens its DM with the manager and joins the named channels only after the administrator invites it.

Owner: the messaging administrator.
