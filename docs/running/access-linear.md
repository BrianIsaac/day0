# Connect Linear for the organisation

This is the recipe we run with a customer's Linear administrator during the
install (`./setup.sh access`, or `./setup.sh install`, which runs it; the
runbook is [install.md](install.md)). Day0 reaches Linear through an OAuth app
the customer registers, installed as the **app actor**: what Day0 writes in
Linear is written by the app, never by a person's account.

Linear is connected in one of two modes, chosen per install and recorded on
the connection and in the install record:

- **Shared** (the default): one app, `Day0`, used by every employee through
  client-credentials tokens. IT acts once, at install.
- **Per employee**: one app per employee, so each employee is its own app user
  in Linear and a ticket is handed to it by assigning it to that app user.
  Linear documents one app user per app per workspace, so each employee needs
  its own app, created and installed by a Linear administrator when the
  employee's card asks for it. Nothing is handed to the setup verb for this
  mode: it lands the connection with no client id and no secret, since each
  employee's own app brings its own.

## 1. What IT creates

**Shared.** A Linear workspace administrator (installing an app as the app
actor needs administrator permissions) creates one OAuth application from the
manifest below: open the link `./setup.sh access --print-manifest linear`
prints while signed in to Linear, check that **Client credentials** is
enabled on the form (the manifest enables it), and create the app. Linear
shows its **client id** and **client secret**.

**Per employee.** When an employee's Linear card asks for access, its manager
forwards the access request to IT. A Linear administrator creates the
employee's own app from the same manifest with the employee's name
(`<employee name> (Day0)`) and without client credentials. An administrator
then opens the link in the access request, which names the employee's card on
the organisation page (`${DAY0_PUBLIC_URL}/organisation?card=<card>`), and
records the app's client id and client secret there; Day0 then opens Linear
for a Linear administrator to install it with `actor=app`. The card asks IT for
nothing more: afterwards its Connect gives a fresh installation link (valid 15
minutes) whenever the employee's app needs installing again.

## 2. The manifest or the form

Linear's app manifests pre-fill the create form; no API creates an app. For a
shared app on an install whose `DAY0_PUBLIC_URL` is `https://day0.acme.example`,
the manifest is:

<!-- access-kit: manifest shared -->

```json
{
  "$schema": "https://linear.app/.well-known/oauth-app-manifest.schema.json",
  "schemaVersion": "1.0.0",
  "distribution": "private",
  "display": {
    "description": "Day0 digital employees: each takes its own Linear tickets and acts on them."
  },
  "developer": {
    "name": "Day0"
  },
  "oauth": {
    "client_name": "Day0",
    "client_uri": "https://day0.acme.example",
    "redirect_uris": [
      "https://day0.acme.example/api/oauth/linear"
    ],
    "grant_types": [
      "authorization_code",
      "client_credentials"
    ]
  },
  "webhook": {
    "enabled": false
  }
}
```

The redirect is `${DAY0_PUBLIC_URL}/api/oauth/linear`, byte for byte. An
employee's own app has its own name and `grant_types` of
`authorization_code` only. A name may not contain the word Linear.

## 3. The scopes

Linear's manifests carry no scopes: Day0 asks for them when it obtains a
token. `write` is the only scope that changes an issue's state;
`comments:create` covers comments only, so it is not enough on its own.

**Shared.** The registration holds:

<!-- access-kit: scopes shared -->

```text
read
write
app:assignable
```

and every client-credentials token is requested with this one fixed set:

<!-- access-kit: client-credentials shared -->

```text
read
write
app:assignable
```

The set never changes after install: Linear revokes and replaces every
app-actor token of an app when a token is requested with other scopes. A
connection landed without `app:assignable` (before v0.15.0, the kit landed
`read` and `write` only) is changed by revoking it on the organisation page
and landing it again; `check:access` names it as a gap.

**Per employee.** Each employee's app is authorised with:

<!-- access-kit: scopes per-employee -->

```text
read
write
app:assignable
```

In both modes `app:assignable` is what lets a manager hand an employee a
ticket by delegating or assigning it to the app user. Without it Linear
refuses the ticket ("One or more app users lack the required capability."),
and the employee takes only unassigned tickets. Linear accepts the scope only
from a token that acts as the app (`actor=app`, or client credentials), and
checks it on a live token, which Day0 holds while a card is connected.

## 4. The allow-list

Linear keeps none for OAuth apps beyond the redirect URIs in the manifest.
Where the workspace restricts which applications may be installed, the
administrator who installs the app is the gate.

## 5. The secret and its lifetime

**Shared.** The client secret lasts until IT rotates it in Linear, which ends every token issued with it; each client-credentials token Day0 obtains lasts 30 days.

**Per employee.** Each employee's app's client secret lasts until IT rotates it; the access tokens it issues last 24 hours and are refreshed by Day0.

After a rotation in Linear, an administrator rotates the connection's secret on
Day0's organisation page.

## 6. What to hand to the setup verb

**Shared.** The verb asks for the client id, and the client secret in a hidden
prompt:

```bash
./setup.sh access
```

For a scripted install, from a file readable by you alone, on stdin; a secret
is never a command-line flag:

```bash
umask 077
cat > answers.env <<'EOF'
LINEAR_CLIENT_ID=<the client id>
LINEAR_CLIENT_SECRET=<the client secret>
EOF
./setup.sh access --administrators it@acme.com --connect-mode linear=shared --secrets-stdin < answers.env
rm answers.env
```

**Per employee.** Nothing to hand over:
`./setup.sh access --administrators it@acme.com --connect-mode linear=per-employee`
lands the connection with its mode, scopes and redirect, and no secret. Each
employee's app arrives through its card's access request. A per-employee
connection has no organisation secret to rotate.

## 7. What check:access must show

`pnpm check:access` (the verb runs it at the end) prints, for `linear`:

| Check | Must be |
|---|---|
| `status` | `pass`: Linear is connected, shared |
| `redirect` | `pass`: the registered redirect is `${DAY0_PUBLIC_URL}/api/oauth/linear` |
| `scopes` | `pass`: `read, write, app:assignable`, and the token Linear grants holds all three |
| `secret` | `pass`: opens under the deployment's key |
| `identity` | `pass`: Linear answers as the app (`viewer`) with a client-credentials token, which the check revokes again |

A `GAP` names what to fix: client credentials not enabled on the app or a
secret that is no longer the current one (Linear's `invalid_client`), a
redirect that is not Day0's, a scope Linear did not grant, or a shared
connection landed without `app:assignable`, to which no ticket can be
delegated: revoke it and land it again.
