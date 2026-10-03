# Installing Day0 at a customer

The runbook for installing Day0 on a customer's machine with the customer's
IT, both halves in one sitting: the **company sign-in** (people sign in
through the customer's own identity provider) and the **organisation's
systems** (IT connects Slack, Linear and any MCP server once, and every
employee Day0 deploys then acts through that connection under its own
identity). One command runs both: `./setup.sh install`. Each half stays
runnable on its own (`./setup.sh sign-in`, `./setup.sh access`).

Secrets are typed into hidden prompts or read from a file on stdin, never put
on a command line, and never printed. The install sends each one to the
customer's own deployment on this machine and, from this machine, to the vendor
that issued it and nowhere else: `pnpm check:access` asks Slack whether it
accepts the configuration token and Linear whether it accepts the client
secret, and the company sign-in's client secret may be given in the
environment (`DAY0_OIDC_CLIENT_SECRET`) instead of the prompt. Since a check from
this machine says nothing about the backend container's own way out to the
vendor, `pnpm check:access` also asks each vendor's address from inside the
backend container (`reach`), with a plain request that carries no secret: a
pass there says the deployment itself reaches Slack, Linear and the MCP server.

## Before the day

Ask the customer's IT to have ready, or to do with you on the day:

1. **A machine** that runs Docker (x86_64), with the checkout of the release
   tag, and the model route chosen (README, "Local, cloud model" or "Local,
   local model").
2. **An https proxy** in front of the machine, with two origins: one for the
   app (`DAY0_PUBLIC_URL`, for example `https://day0.acme.com`) and one for the
   backend (`--backend-url`, for example `https://convex.day0.acme.com`, proxied
   to the backend's port), since people's browsers call both.
3. **The identity provider's app registration**, following the guide for it:
   [Microsoft Entra ID](sign-in-entra.md), [Okta](sign-in-okta.md),
   [Google Workspace](sign-in-google.md), or [any other OpenID Connect
   issuer](sign-in-oidc.md). It needs the redirect URI
   `${DAY0_PUBLIC_URL}/api/auth/oidc/callback`.
4. **The administrators**: the addresses of the people who will manage the
   organisation's connections in Day0 (they sign in with them; a manager
   cannot manage a connection).
5. **For each system the documentation names**, its recipe:
   [Slack](access-slack.md) (a workspace service account; the configuration
   token is generated on the day, since it lasts 12 hours),
   [Linear](access-linear.md) (an administrator who creates the app from the
   manifest), and [an MCP server](access-mcp.md) (a client registration at
   its authorisation server). Other systems the documentation names keep the
   pasted key on each employee's card until Day0 has an issuer for them;
   `./setup.sh access` lists them.

## On the day

### 1. The machine

```bash
./setup.sh --route featherless
```

or another route (README). This starts the stack and writes `.env.local`.

### 2. The install

With IT beside you:

```bash
./setup.sh install --provider entra --backend-url https://convex.day0.acme.com
```

It runs, in order, and **stops at the first step that fails, naming it**:

1. **The target checks** the lifecycle verbs run: the installation is this
   checkout's, its project is the one `.env.local` names, and it is not a
   protected one.
2. **The backend's public address** (`--backend-url`), written as
   `NEXT_PUBLIC_CONVEX_URL` and kept by every later push, resume and upgrade.
3. **The company sign-in** (`./setup.sh sign-in`): it asks for the tenant (or
   domain, or issuer), the client id, the client secret (hidden), the allowed
   domains and the public origin, writes them, pushes them, restarts the
   backend and runs `pnpm check:setup`. Where the identity provider's
   certificate comes from a private certificate authority (a test issuer; a
   customer's own issuer usually has a public one), this step stops with
   "This machine cannot read
   https://.../.well-known/openid-configuration:
   UNABLE_TO_VERIFY_LEAF_SIGNATURE". Run the install with
   `NODE_EXTRA_CA_CERTS=<the CA bundle> ./setup.sh install ...`, the same
   trust step 6 needs for the proxy.
4. **The organisation's systems** (`./setup.sh access`): it asks for the
   administrators, lists the systems the documentation names, and for each one
   the kit connects shows its recipe and records its mode (Slack and an MCP
   server per employee; Linear shared, or per employee with
   `--connect-mode linear=per-employee`, which lands the connection with no
   secret and leaves each employee's own app to its access request), asks for
   what the recipe produced
   (secrets hidden), lands it, runs `pnpm check:access` and writes the install
   record.
5. **`pnpm check:setup`**, now with the access block.
6. **`pnpm build`**: the browser reads the company sign-in's profile at build.
   Then start the app behind the proxy (`pnpm start`, in another terminal or
   under the customer's service manager); the install waits up to 10 minutes
   for it to answer at `DAY0_PUBLIC_URL`, and says the last error if it never
   does. Where the proxy's certificate comes from the customer's own
   certificate authority, this machine's Node must trust it: run the install
   with `NODE_EXTRA_CA_CERTS=<the CA bundle> ./setup.sh install ...`, or the
   wait never succeeds.

   The backend container needs the same trust. Step 4's check dials each
   vendor from inside it, and an install where that dial cannot run stops
   there. Where its way out passes such a proxy, give the container the
   bundle: `SSL_CERT_FILE` for the check, `NODE_EXTRA_CA_CERTS` for the
   deployment's calls. The kit sets neither, so agree with IT before the day
   how the bundle reaches the container.
7. **`pnpm check:sign-in`**: it prints a link; someone from IT opens it in a
   private window and signs in as a test person; it shows each claim's
   verdict and what the deployment made of the token.

When a step stops the install, fix what it said and run `./setup.sh install`
again: every step before it keeps what it wrote, a connection already landed
is left as it is, and nothing is asked twice that the file already holds.

### A scripted install

Every answer can come from a file on stdin instead of the terminal, one
`NAME=value` per line; a secret is never a command-line flag. Write the file
readable by you alone and remove it after:

```bash
umask 077
cat > answers.env <<'EOF'
DAY0_OIDC_CLIENT_SECRET=<the app registration's client secret>
SLACK_CONFIGURATION_TOKEN=<the configuration token>
SLACK_CONFIGURATION_REFRESH_TOKEN=<its refresh token>
LINEAR_CLIENT_ID=<the Linear app's client id>
LINEAR_CLIENT_SECRET=<the Linear app's client secret>
EOF
./setup.sh install --provider entra --tenant <tenant id> --client-id <client id> \
  --allowed-domains acme.com --public-url https://day0.acme.com \
  --backend-url https://convex.day0.acme.com \
  --administrators it@acme.com --connect-mode linear=shared --secrets-stdin < answers.env
rm answers.env
```

### 3. Keep the app running

The install built the app and waited for it; keep `pnpm start` running behind
the proxy, on port 3000, which the proxy forwards `DAY0_PUBLIC_URL` to, under
the customer's service manager.

### 4. The install record

`./setup.sh access` writes `~/day0-install/<project>/install-record-<date>.md`
(`--record <dir>` elsewhere): what was registered and where, the redirect URIs,
each connection's mode and scopes, the administrators, and when each secret
expires. It holds no secret. Hand it to the customer's IT. A later run the same
day adds its own section below the earlier ones, so a day's record names every
connection landed that day.

## Each half alone

| Command | What it does |
|---|---|
| `./setup.sh sign-in --provider entra` | the company sign-in only, ending on `pnpm check:setup` |
| `./setup.sh access` | the organisation's systems only, ending on `pnpm check:access` |
| `./setup.sh access --print-manifest slack` | prints the Slack app manifest Day0 creates employees' apps from (`linear` prints the Linear app's, and the link that pre-fills its form with the manifest's fields; `linear --employee <name>` an employee's own app's) |
| `./setup.sh access --dry-run` | lists the systems and what would be landed; writes nothing |
| `./setup.sh access --correct <system>` | records the redirect Day0 returns to and the kit's scopes on a connection, after IT fixed them at the vendor; no secret changes and no card ends. A fixed set it cannot change is reported, not corrected |
| `pnpm check:setup` | every setting, the sign-in block and the access block, without calling a vendor |
| `pnpm check:access` | each connection: its status, redirect, scopes, whether its secret opens, and whether its vendor answers with it |
| `pnpm check:sign-in` | one test sign-in, each claim's verdict |

## When a check fails

| `pnpm check:access` says | Do |
|---|---|
| `administrators` GAP | `./setup.sh access --administrators <addresses>` |
| `redirect` GAP | register exactly `${DAY0_PUBLIC_URL}/api/oauth/<system>` at the vendor, then `./setup.sh access --correct <system>` records it; or set `DAY0_PUBLIC_URL` back to the origin it was registered with |
| `scopes` GAP, missing a scope ("Missing scope ...") | grant the missing scopes at the vendor (the recipe lists them), then `./setup.sh access --correct <system>` records them |
| `scopes` GAP, landed without part of a fixed set ("... was landed with ..., without ...") | a fixed set, such as the `read, write` a shared Linear connection landed by v0.14.0 holds without `app:assignable`, cannot be changed in place, and a correction does not reach it: revoke the connection on the organisation page, then land it again with `./setup.sh access`. Every card on it ends, and each manager connects it again |
| `secret` GAP | the deployment's credential key changed since the secret was landed: rotate the connection with a fresh secret |
| `identity` GAP, no issuer ("No issuer is recorded ...", an MCP connection) | revoke the connection on the organisation page, then land it again with `./setup.sh access`, which finds the issuer from the server's own metadata. Every card on it ends |
| `identity` GAP, any other | the vendor refused the secret: generate a new one by the recipe and rotate the connection |
| `reach` GAP | the backend container could not reach the vendor. When it does not trust the certificate, give the backend container the customer's CA bundle (see the note under step 6, `SSL_CERT_FILE`); otherwise open its way out (the proxy or firewall in front of the backend). Then run the check again |
| `reach` WARN ("Not asked from the backend container") | start the backend (`./setup.sh resume`) and run the check again |
| `status` GAP | the connection needs IT's attention, for the reason it gives |

## How long it takes

Measured on 2 October 2026 on a test bed (the test identity provider and the
fake Slack, one system connected), on a machine that already held the Docker
images, the pnpm store and a copy of the redactor's volumes (`--warm-from`):

| Step | Time |
|---|---|
| Clean clone to dependencies installed | 2 s |
| `./setup.sh --route featherless` (the machine) | 40 s |
| The bed's own step (the test issuer added to the stack) | 24 s |
| `./setup.sh install`, the build and the live sign-in check included | 55 s |
| **From a clean clone to a passing install** | **2 min 1 s** |

A first install on a new machine adds the image pulls, the redactor's model
download and IT's own steps at each vendor; time those with the customer and
plan for them.
