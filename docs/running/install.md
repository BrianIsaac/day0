# Installing Day0 at a customer

The runbook for installing Day0 on a customer's machine with the customer's
IT, both halves in one sitting: the **company sign-in** (people sign in
through the customer's own identity provider) and the **organisation's
systems** (IT connects Slack, Linear and any MCP server once, and every
employee Day0 deploys then acts through that connection under its own
identity). One command runs both: `./setup.sh install`. Each half stays
runnable on its own (`./setup.sh sign-in`, `./setup.sh access`).

The install never sends a customer's secret anywhere but the customer's own
deployment on this machine: secrets are typed into hidden prompts or read from
a file on stdin, never put on a command line, and never printed.

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
   backend and runs `pnpm check:setup`.
4. **The organisation's systems** (`./setup.sh access`): it asks for the
   administrators, lists the systems the documentation names, and for each one
   the kit connects shows its recipe, asks for its mode (per employee or
   shared) and for what the recipe produced (secrets hidden), lands it, runs
   `pnpm check:access` and writes the install record.
5. **`pnpm check:setup`**, now with the access block.
6. **`pnpm build`**: the browser reads the company sign-in's profile at build.
   Then start the app behind the proxy (`pnpm start`, in another terminal or
   under the customer's service manager); the install waits up to 10 minutes
   for it to answer at `DAY0_PUBLIC_URL`.
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
expires. It holds no secret. Hand it to the customer's IT.

## Each half alone

| Command | What it does |
|---|---|
| `./setup.sh sign-in --provider entra` | the company sign-in only, ending on `pnpm check:setup` |
| `./setup.sh access` | the organisation's systems only, ending on `pnpm check:access` |
| `./setup.sh access --print-manifest slack` | prints the Slack app manifest Day0 creates employees' apps from (`linear` prints the Linear app's, and the link that pre-fills its form) |
| `./setup.sh access --dry-run` | lists the systems and what would be landed; writes nothing |
| `pnpm check:setup` | every setting, the sign-in block and the access block, without calling a vendor |
| `pnpm check:access` | each connection: its status, redirect, scopes, whether its secret opens, and whether its vendor answers with it |
| `pnpm check:sign-in` | one test sign-in, each claim's verdict |

## When a check fails

| `pnpm check:access` says | Do |
|---|---|
| `administrators` GAP | `./setup.sh access --administrators <addresses>` |
| `redirect` GAP | register exactly `${DAY0_PUBLIC_URL}/api/oauth/<system>` at the vendor, or set `DAY0_PUBLIC_URL` back to the origin it was registered with |
| `scopes` GAP | grant the missing scopes at the vendor (the recipe lists them), then rotate the connection on the organisation page |
| `secret` GAP | the deployment's credential key changed since the secret was landed: rotate the connection with a fresh secret |
| `identity` GAP | the vendor refused the secret: generate a new one by the recipe and rotate the connection |
| `status` GAP | the connection needs IT's attention, for the reason it gives |

## How long it takes

Timed from a clean clone on a test bed (fake identity provider, fake Slack),
2 October 2026: see the section below once measured.
