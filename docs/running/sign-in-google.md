# The company sign-in with Google Workspace

Day0 installed at a customer signs people in through the customer's own
identity provider: their managers use their work accounts, and nobody signs in
whom the customer's IT has not let in. This guide is what we run with the
customer's Google Workspace administrator, once, after `./setup.sh --route ...`
has set Day0 up on the customer's machine. The Entra and Okta guides follow the
same seven steps: [sign-in-entra.md](sign-in-entra.md), [sign-in-okta.md](sign-in-okta.md).

Google's issuer, `https://accounts.google.com`, is shared by every Google
account in the world, so the client id alone does not keep strangers out.
Day0 therefore also checks the token's `hd` claim, the Workspace the account
belongs to, against the allowed domains (step 4).

Before you start you need:

- the address people will reach Day0 on, through the customer's reverse
  proxy, as an `https` origin with no path, such as `https://day0.acme.com`.
  It is `DAY0_PUBLIC_URL`;
- a Google Cloud project in the customer's organisation, and someone who can
  configure its OAuth consent screen and create credentials;
- outbound https from this machine **and from the backend container** to
  `accounts.google.com` and `www.googleapis.com` (where Google publishes its
  signing keys). The backend fetches them itself, and a container does not
  inherit the host's proxy settings, so a firewall that admits the host and
  not the container refuses every sign-in. `pnpm check:setup` tests both.

## 1. Register the application

In the Google Cloud console, in the customer's project:

- **APIs & Services > OAuth consent screen**: user type **Internal**. Only
  accounts in the customer's Workspace can then consent at all. App name Day0.
- **APIs & Services > Credentials > Create credentials > OAuth client ID**:
  application type **Web application**, name Day0.

## 2. The redirect URI

Under **Authorised redirect URIs**, add
`https://day0.acme.com/api/auth/oidc/callback`, with the customer's
`DAY0_PUBLIC_URL` in place of `https://day0.acme.com`; the setup verb prints it
exactly. Google publishes no sign-out endpoint, so there is no sign-out URI to
register: Day0's Sign out ends Day0's session, and the Google session stays as
the customer's browser policy leaves it.

## 3. Scopes and claims

Day0 asks for `openid email profile`, which need no sensitive-scope
verification. Google sends `email_verified` and, for a Workspace account, `hd`.
A refresh token comes from `access_type=offline` rather than a scope, and
Google grants one only at the first consent unless the request says
`prompt=consent`; Day0 always sends both, so each sign-in asks the person to
consent and brings a refresh token.

## 4. Who may sign in

Three things decide it:

1. **Google's consent screen**, set to *Internal* in step 1: an account outside
   the customer's Workspace cannot sign in to the app at all. To narrow it
   further, the Workspace admin can restrict the app under **Security > Access
   and data control > API controls**.
2. **The allowed domains**, `DAY0_OIDC_ALLOWED_DOMAINS`: the Workspace's
   domains, such as `acme.com`. Day0 checks both the token's `email` and its
   `hd` against them, at the callback and again on the backend. A personal
   Google account carries no `hd` and is refused, whatever its address.
3. **A verified address**, which Google's `email_verified` gives.

## 5. The secret and its expiry

The OAuth client's page shows its **Client ID** and **Client secret**. Google
client secrets do not expire on their own; the customer's policy may rotate
them. Note who holds it and when it was made. To rotate it, add a secret on the
same client, run `./setup.sh sign-in` again with the new value (everything else
is kept, nobody is signed out), then disable the old one.

## 6. What to hand to the setup verb

On the customer's machine, in the Day0 checkout:

```bash
./setup.sh sign-in --provider google \
  --client-id <Client ID>.apps.googleusercontent.com \
  --allowed-domains acme.com \
  --public-url https://day0.acme.com
```

There is no issuer to name. The client secret is asked for in a hidden
prompt, never on the command line, where it would stay in the shell's history;
any flag left out is asked for too. The verb writes the customer-local block of
`.env.local` with a generated session secret, pushes the values to the backend,
restarts it, and runs `pnpm check:setup`, exiting with its status. Then build
and start the app again (`pnpm build`, then `pnpm start` behind the proxy): the
browser reads the profile at build.

## 7. What the live check must show

With the customer's IT, and a test person in the Workspace:

```bash
pnpm check:sign-in
```

It prints a link good for ten minutes. Open it in a private window and sign in as the test
person. The page and the terminal then show one line per claim, and every line
must be `pass`:

| Claim | Must be |
|---|---|
| `iss` | `https://accounts.google.com`, byte for byte |
| `aud` | the client id |
| `sub` | present (the person, as Day0 keys them) |
| `email` | the person's address, in an allowed domain |
| `email_verified` | `true` |
| `hd` | the Workspace's domain, in the allowed domains |
| `exp` | the token's lifetime, an hour |
| `refresh_token` | granted (if not, the consent screen did not ask: check step 3) |
| `whoAmI` | the owner key the backend derived: the backend fetched Google's keys and accepted the token |

Keep the output (`pnpm check:sign-in --report` prints a JSON copy with the
claim names and verdicts and no values) with the install's support bundle,
`pnpm --silent check:setup --report`.
