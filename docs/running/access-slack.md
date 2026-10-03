# Connect Slack for the organisation

This is the recipe we run with a customer's Slack administrator during the
install (`./setup.sh access`, or `./setup.sh install`, which runs it; the
runbook is [install.md](install.md)). It connects Slack once, for the whole
organisation: afterwards each employee Day0 deploys gets **its own Slack app**,
created by Day0 from the manifest below, so it posts as itself and never as a
person. Nobody pastes a token on an employee's card.

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
   workspace. Slack shows two values: the **access token** (the configuration
   token) and the **refresh token**. Copy both now; Slack does not show them
   again.
3. **A second collaborator** on each app Day0 creates: once an employee's app
   exists (its name is `<employee name> (Day0)`), add a second collaborator
   on its **Collaborators** page, an IT administrator or a second service
   account, so the app outlives the first account.
4. Where the workspace requires an administrator to approve app installs, an
   administrator installs each employee's app from the install link Day0 gives
   the employee's manager. Installing is the approval.

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
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

The redirect is `<Day0 public URL>/api/oauth/slack`, with `DAY0_PUBLIC_URL`
the https origin people reach Day0 on through the customer's proxy. Slack
refuses a plain-http redirect.

## 3. The scopes

Each employee's app asks for exactly the methods Day0 calls in Slack, and no
more: `chat.postMessage` and `chat.update` (`chat:write`), `conversations.list`
(`channels:read`, `im:read`), `conversations.history` and
`conversations.replies` (`channels:history`, `im:history`), `conversations.open`
(`im:write`), `users.lookupByEmail` (`users:read.email`, which Slack grants
only with `users:read`) and `conversations.join` (`channels:join`). `auth.test`
needs none. When an employee's access is renewed after it expired or was
disconnected, Slack has taken its bot out of every channel; with
`channels:join` the employee re-joins the public channels its approved intake
scope names itself. There is no `groups:` scope: a private channel is added by
hand by someone in it, and the employee's card names each one that needs it.

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

The configuration token expires 12 hours after it is generated. Day0 renews it with its refresh token before any use in its last half hour and, once it has used it, an hour before it lapses; the refresh token also renews a token that has lapsed. Each renewal returns a new pair.

So hand both to the setup verb together: an install that runs after the
configuration token has lapsed still lands, and Day0 renews the token with the
refresh token at its first use. The refresh token keeps the connection usable
for as long as Day0 keeps renewing it; once Day0 has renewed the pair, the one
you generated is spent. An administrator rotates or revokes the connection on
Day0's organisation page.

A revoke, and a rotation, revokes the configuration token Day0 held at Slack
(`auth.revoke`), which ends that token alone: its refresh token stays usable
at Slack by whoever holds it, and Slack offers no call that ends a refresh
token. So after a revoke, IT signs in to <https://api.slack.com/apps> as the
service account and, under **Your App Configuration Tokens**, deletes the
workspace's row: deleting it ends the pair. The connection's ledger on the
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

A `GAP` names what to fix: a redirect that is not Day0's (the public address
changed since the connection was landed), a scope the connection lacks, a
secret the deployment cannot open, or Slack's own refusal of the token.
