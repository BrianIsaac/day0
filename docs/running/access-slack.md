# Connect Slack for the organisation

This is the recipe we run with a customer's Slack administrator during the
install (`./setup.sh access`, or `./setup.sh install`, which runs it; the
runbook is [install.md](install.md)). It connects Slack once, for the whole
organisation: afterwards each employee Day0 deploys can get **its own Slack
app**, created by Day0 from the manifest below, so it posts as itself and never
as a person, and nobody pastes a token on its card. That holds when the
employee's linked documentation describes the app's install: a page about Slack
that says the employee's app is installed by OAuth or created with the
organisation's configuration token (a page carrying the manifest of section 2
does), and that records no bot token of its own. A page that records a bot
token for the employee makes its card a pasted-token card, and with no page of
either kind the card says what is missing and offers no app.

Slack is connected **per employee** only: one app per employee, its own bot
user, its own permissions. The organisation's connection holds what Day0
needs to create those apps: an app configuration token and its refresh token.

## 1. What IT creates

1. **A workspace service account**: a member account IT owns for this purpose
   (for example `day0-apps@acme.com`), not a person's account. Slack revokes a
   member's tokens when the member is deactivated, and may deactivate an
   internal app when every collaborator on it is deactivated, so an app
   configuration token generated from a person's account stops working the
   day that person leaves.
2. Signed in to <https://api.slack.com/apps> **as that service account**, under
   **Your App Configuration Tokens**, **Generate Token** for the customer's
   workspace. Slack shows neither value: the table gains a row for the
   workspace with two buttons, **Copy access token** (the configuration
   token) and **Copy refresh token**. Once Day0 has renewed the pair the row
   yields Day0's current pair: whoever signs in as the service account can
   copy the live tokens, so its sign-in is guarded as the secret it is. The
   row's **Delete token** ("Revoke this token?") ends the access token only:
   the refresh token still renews after it. **Generate Token** is disabled
   while the account holds a token for that workspace, so a fresh pair needs
   the old row deleted first; do that only when the connection is to be
   landed again or rotated at once.
3. **A second collaborator** on each app Day0 creates: once an employee's app
   exists (its name is `<employee name> (Day0)`), add a second collaborator
   on its **Collaborators** page, an IT administrator or a second service
   account, so the app outlives the first account.
4. Where the workspace requires an administrator to approve app installs, an
   administrator installs each employee's app from the install link Day0 gives
   the employee's manager. Installing is the approval.
5. **For decision buttons, each app's app-level token** (optional, one click
   per app; below). Until an app has one, its manager decides each request by
   its typed code, a reply in the DM with the app (once the app takes
   messages, below), or in Day0.

### Typed codes: each app's messages tab

Each request Day0 sends an employee's manager ends with a typed code
(`approve ab3xyz`), a reply in the manager's DM with the employee's app. Slack
refuses any message to an app whose App Home messages tab is off or read-only:
the DM says "Sending messages to this app has been turned off." and offers no
place to type. So:

- An app Day0 creates from the manifest in section 2 takes messages from the
  start.
- An app Day0 created before v0.16.0 has the tab read-only. Day0 opens it
  itself with `apps.manifest.update`, changing nothing else, at the next check
  of the app's card (the hourly re-check, or **Check the connection** on the
  card), while the organisation's configuration connection that created it is
  still active. Both calls (`apps.manifest.export`, then the update) are on
  that connection's ledger; if Slack refuses the update, the card's row stays
  and the next bullet applies.
- Where Day0 cannot (the app was created with a configuration token pasted on
  its card, the connection that created it is marked **Needs IT** on the
  organisation page, or Slack refused the update), a collaborator on the app
  opens it: signed in to <https://api.slack.com/apps>, open the app, **App
  Home**, and under **Messages Tab** tick **Allow users to send Slash commands
  and messages from the messages tab** (turn **Messages Tab** on first if it is
  off). Then the manager presses **It is on in Slack** on the employee's Slack
  card.

A tab turned off altogether refuses more than the typed code: Slack then
refuses the app's own messages too, so Day0's request to the manager fails
with `messages_tab_disabled` until the tab is on. An `apps.manifest.update`
that leaves out `app_home` turns it off this way, and `apps.manifest.export`
reads the same for such an app as for a read-only tab, so anyone updating an
employee's manifest by hand keeps its `app_home` block.

Until an app takes messages, each request to its manager says a typed reply
cannot reach it and offers its buttons, where it has them, and Day0 instead, and the card and
`check:access` (the `messages` row) name the app.

### Decision buttons: each app's app-level token

Each request Day0 sends an employee's manager carries a typed code (`approve
ab3xyz`), which decides it once the app takes messages (above). With the
employee's app's **app-level token**, the request also carries **Approve** and
**Reject** buttons. Slack offers no API
that issues an app-level token, so a person generates one per app:

1. Signed in to <https://api.slack.com/apps> as a collaborator on the
   employee's app (`<employee name> (Day0)`), open it.
2. **If Socket Mode is off** (every app Day0 created before v0.16.0): on its
   **Socket Mode** page turn on **Enable Socket Mode**. Slack's own dialog,
   "Generate an app-level token to enable Socket Mode", already carries the
   scope `connections:write`: give it any name (for example `day0-buttons`),
   **Generate**, and **Copy** the token (it starts `xapp-`). Interactivity turns
   on with it, with no request URL asked for. Go to step 4: the dialog made the
   token, so step 3 would make a second one.
3. **If Socket Mode is on** (apps Day0 created from v0.16.0, from the manifest
   in section 2, have it and Interactivity on already): **Basic Information**, **App-Level Tokens**,
   **Generate Token and Scopes**, any name, the scope **`connections:write`**,
   **Generate**. Copy the token (it starts `xapp-`).

   Either way the token stays copyable from its row under **App-Level
   Tokens** for as long as it lives, to anyone who can open the app's settings
   (each collaborator), as the configuration token's row does: Day0 never shows
   it again, but Slack does.
4. In Day0, the employee's **Slack** card, **App-level token**: paste it and
   press **Turn on buttons**. Day0 checks it by opening a Socket Mode connection
   with it, keeps it encrypted and held by the organisation, and never shows it
   again. The card then says "Decisions in Slack: buttons are on while the Slack
   socket service runs", and each new request carries the buttons, beside its
   typed code where the app takes messages; a request asked before the token
   landed carries no buttons.

Slack sets no expiry on the token. It ends when the app is deleted (a retire
deletes it) or when a collaborator revokes it on the same page; presses then
stop reaching Day0 until a new token is landed on the card, and each request is
decided by its typed code where the app takes messages, or in Day0. A token landed again replaces the last, and the `slack-socket` component dials
with it at its next read of the app list, within half a minute, so a token of
another app shows in `check:access` (the `socket` row) by then. The `slack-socket` component must run (real-mode setup starts
it) and reach Slack's Socket Mode host outbound over `wss://`: the host in the
URL Slack's `apps.connections.open` answers, which was `wss-primary.slack.com`
in October 2026 (`pnpm check:setup --report` lists it under `egress`); nothing
inbound is opened.

## 2. The manifest or the form

IT creates no app by hand: Day0 creates each employee's app with
`apps.manifest.create` from this manifest, filling in the employee's name and
Day0's public address. `./setup.sh access --print-manifest slack` prints it.
A policy page that carries this block in a fenced `json` block provisions the
same app, since Day0's documentation reader finds it there.

<!-- access-kit: manifest -->

```json
{
  "display_information": {
    "name": "<employee name> (Day0)",
    "description": "A Day0 digital employee. It drafts first and holds what it posts until its manager approves."
  },
  "features": {
    "bot_user": {
      "display_name": "<employee name> (Day0)",
      "always_online": false
    },
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    }
  },
  "oauth_config": {
    "redirect_urls": [
      "<Day0 public URL>/api/oauth/slack"
    ],
    "scopes": {
      "bot": [
        "chat:write",
        "channels:read",
        "channels:history",
        "channels:join",
        "im:read",
        "im:write",
        "im:history",
        "users:read",
        "users:read.email"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false,
    "interactivity": {
      "is_enabled": true
    }
  }
}
```

Socket Mode and interactivity are on with **no request URL**: a press of a
decision request's Approve or Reject button reaches Day0 over a WebSocket Day0
dials out (the `slack-socket` component), so the app declares no inbound
address. Slack's manifest check refuses interactivity with neither a request
URL nor Socket Mode.

The redirect is `<Day0 public URL>/api/oauth/slack`, with `DAY0_PUBLIC_URL`
the https origin people reach Day0 on through the customer's proxy. https is
Day0's own rule, not Slack's (Slack's manifest check accepts an http redirect):
the codes and tokens come back on the redirect.

## 3. The scopes

Each employee's app asks for the scopes of exactly the methods Day0 calls in
Slack, and no more: `chat.postMessage` and `chat.update` (`chat:write`), `conversations.list`
(`channels:read`, `im:read`), `conversations.history` and
`conversations.replies` (`channels:history`, `im:history`), `conversations.open`
(`im:write`), `users.lookupByEmail` (`users:read.email`, which Slack grants
only with `users:read`) and `conversations.join` (`channels:join`). `auth.test`
needs none. When an employee's access is renewed after it expired or was
disconnected, Slack has taken its bot out of every channel; with
`channels:join` the employee re-joins the public channels its approved intake
scope names itself. There is no `groups:` scope: a private channel is added by
hand by someone in it, and the employee's card names each one that needs it.

**What a card may call is read from the documentation.** The scopes let the
app call these methods; the employee's Slack card calls only the ones its
linked documentation names, so the Slack page must name each of `auth.test`,
`users.lookupByEmail` and `conversations.open` (the card does not connect
without them), `conversations.list`, `conversations.history` and
`conversations.replies` (intake reads nothing without them), `chat.postMessage`
(nothing is posted without it), `chat.update` (without it a decided request
keeps its buttons) and `users.info` (without it an ask is shown under the
asker's id). A manager's **Change approved tools** cannot add a method the
pages do not name: the card says it is approved but not offered.

<!-- access-kit: scopes per-employee -->

```text
chat:write
channels:read
channels:history
channels:join
im:read
im:write
im:history
users:read
users:read.email
```

The configuration token itself carries no bot scope: it may create and delete
apps in the workspace, which is why it belongs to a service account and why
Day0 uses it for nothing but its own employees' apps.

## 4. The allow-list

Slack keeps none for this: the configuration token is the whole grant. Where
the workspace restricts which apps may be installed, the install approval in
step 1.4 is the gate.

## 5. The secret and its lifetime

The configuration token expires 12 hours after it is generated. Day0 cannot tell how old a pair you hand it is, so it renews the pair with its refresh token at its first use or a quarter of an hour after it lands, whichever comes first (later while the deployment's scheduled jobs are paused); from then on it renews it before any use in its last half hour and an hour before it lapses, and the refresh token also renews a token that has lapsed. Each renewal returns a new pair. A revoke, or the row's Delete on api.slack.com, ends the access token only. Nothing ends a refresh token but its lapse, so keep the service account's sign-in closed: whoever copies a refresh token while its row is listed can mint a token with it until then.

So hand both to the setup verb together: an install that runs after the
configuration token has lapsed still lands, and Day0 renews the token with the
refresh token at its first use. The refresh token keeps the connection usable
for as long as Day0 keeps renewing it. Day0 renews the pair soon after it lands
(above), so the refresh token you generated is spent then, though the access
token you generated still works until its 12 hours are up unless it is revoked. An administrator
rotates or revokes the connection on Day0's organisation page.

A revoke, and a rotation, revokes the configuration token Day0 held at Slack
(`auth.revoke`), which ends that token alone: its refresh token stays usable
at Slack by whoever holds it. Nothing IT can click ends a configuration
refresh token either: the row's **Delete token** on
<https://api.slack.com/apps> ends the access token only, and once no access
token of the pair lives the row is not listed at all, so after Day0's revoke
there is nothing to delete. The refresh token ends only when it lapses. Until
then whoever copied it while its row was listed can mint a token with it, so
keep the service account's sign-in closed. The connection's ledger on the
organisation page says the same after each revoke, and tells a token Day0
revoked from one Slack had already ended.

## 6. What to hand to the setup verb

The verb asks for both values in hidden prompts:

```bash
./setup.sh access
```

For a scripted install, put them in a file readable by you alone and pass it on
stdin; a secret is never a command-line flag:

```bash
umask 077
cat > answers.env <<'EOF'
SLACK_CONFIGURATION_TOKEN=<the access token>
SLACK_CONFIGURATION_REFRESH_TOKEN=<the refresh token>
EOF
./setup.sh access --administrators it@acme.com --secrets-stdin < answers.env
rm answers.env
```

The verb lands the pair as the organisation's Slack connection (`per
employee`, sealed under the deployment's credential key), and records the
redirect URI above.

## 7. What check:access must show

`pnpm check:access` (the verb runs it at the end) prints, for `slack`:

| Check | Must be |
|---|---|
| `status` | `pass`: Slack is connected, per employee |
| `redirect` | `pass`: the registered redirect is `${DAY0_PUBLIC_URL}/api/oauth/slack` |
| `scopes` | `pass`: the nine scopes above |
| `secret` | `pass`: opens under the deployment's key |
| `identity` | `pass`: Slack accepts the configuration token and the kit's manifest (`apps.manifest.validate`); a `note` once the token has lapsed, which the refresh token renews at Day0's next use of it |
| `reach` | `pass`: the backend container reached Slack's Web API (`api.test`, no token sent); a `GAP` names curl's words, cured by opening the deployment's way out to `slack.com` |
| `socket` | `pass`: the `slack-socket` service runs and holds a Socket Mode connection for each employee app with an app-level token; a `note` when it is not running (requests then carry no buttons); a `GAP` names an app with no connection (open the service's way out to Slack's Socket Mode hosts over `wss://`) or a secret the service and the deployment do not share |
| `messages` | `pass`: the typed code reaches every installed employee app (each takes messages); a `note` names an app Day0 opens at its card's next check; a `GAP` names an app only a person can open, with Slack's toggle (section 1, "Typed codes") |

A `GAP` names what to fix: a redirect that is not Day0's (the public address
changed since the connection was landed), a scope the connection lacks, a
secret the deployment cannot open, or Slack's own refusal of the token.
