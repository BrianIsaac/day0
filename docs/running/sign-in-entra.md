# The company sign-in with Microsoft Entra ID

Day0 installed at a customer signs people in through the customer's own
identity provider: their managers use their work accounts, and nobody signs in
whom the customer's IT has not let in. This guide is what we run with the
customer's Entra administrator, once, after `./setup.sh --route ...` has set
Day0 up on the customer's machine. The Okta and Google guides follow the same
seven steps: [sign-in-okta.md](sign-in-okta.md), [sign-in-google.md](sign-in-google.md).

Before you start you need:

- the address people will reach Day0 on, through the customer's reverse
  proxy, as an `https` origin with no path, such as `https://day0.acme.com`.
  It is `DAY0_PUBLIC_URL`;
- an Entra role that can register applications and assign users (Application
  Administrator, or Cloud Application Administrator);
- outbound https from this machine **and from the backend container** to
  `login.microsoftonline.com`. The backend fetches the tenant's signing keys
  itself, and a container does not inherit the host's proxy settings, so a
  firewall that admits the host and not the container refuses every sign-in.
  `pnpm check:setup` tests both.

## 1. Register the application

In the Entra admin centre, **Identity > Applications > App registrations >
New registration**:

- **Name**: Day0.
- **Supported account types**: *Accounts in this organisational directory
  only (single tenant)*. Day0 is set up per tenant and never accepts tokens
  from `common`.
- Leave the redirect URI for step 2.

On the new registration's **Overview** page, note the **Application (client)
ID** and the **Directory (tenant) ID**. Both are GUIDs.

## 2. The redirect URI

**Authentication > Add a platform > Web**, and add two redirect URIs:

| URI | What it is for |
|---|---|
| `https://day0.acme.com/api/auth/oidc/callback` | where Entra sends the browser after sign-in |
| `https://day0.acme.com/api/auth/oidc/logout` | where Entra sends the browser after sign-out (Entra only returns to a registered redirect URI) |

Use the customer's `DAY0_PUBLIC_URL` in place of `https://day0.acme.com`; the
setup verb prints both URIs exactly. Leave *Access tokens* and *ID tokens*
under *Implicit grant* unticked: Day0 uses the authorisation code flow with
PKCE.

## 3. Scopes and claims

Day0 asks for `openid profile email offline_access`, which needs no API
permission beyond Microsoft Graph's default `User.Read` (already granted on a
new registration). `offline_access` brings the refresh token that keeps a
session going past the ID token's hour.

Entra's v2.0 ID token carries no `email_verified`, and Day0 believes a
manager's address only when the token says it is verified. Add the optional
claims that say so: **Token configuration > Add optional claim > ID**, tick
`email` and `xms_edov`, and accept the Graph permission it offers to add.
`xms_edov` is `true` when the address belongs to the tenant the account lives
in and the tenant has verified that domain; it is only sent with `email`.
Guests from SAML or WS-Fed providers never have it.

If the customer cannot add `xms_edov`, and every address its tenant issues is
one it controls, set `DAY0_OIDC_EMAIL_TRUSTED=true` instead. That is the
declared fallback (decision D3): without either, a person signs in and cannot
deploy an employee or take one on.

## 4. Who may sign in

Three things decide it, and the first is the customer's:

1. **Entra's assignment.** **Enterprise applications > Day0 > Properties**:
   set *Assignment required?* to **Yes**, then under **Users and groups**
   assign the managers, or a group of them. Anyone unassigned is refused by
   Entra before Day0 sees them.
2. **The allowed domains**, `DAY0_OIDC_ALLOWED_DOMAINS`: the email domains
   whose people may sign in, such as `acme.com`. Day0 checks the token's
   `email` at the callback and again on the backend.
3. **A verified address** (step 3), which deploying and taking on an employee
   need.

## 5. The secret and its expiry

**Certificates & secrets > Client secrets > New client secret**. Entra secrets
expire: the longest is 24 months, and the admin centre suggests 180 days.
**Write the expiry date in the customer's calendar and ours** the day you make
it: when it lapses every sign-in fails at the callback with "Day0 could not
sign you in", and nothing in Day0 can see the date in advance. Copy the
secret's **Value** (not its ID) once; Entra never shows it again.

To rotate it, make a new secret, run `./setup.sh sign-in` again with the new
value (everything else is kept, nobody is signed out), then delete the old one.

## 6. What to hand to the setup verb

On the customer's machine, in the Day0 checkout:

```bash
DAY0_OIDC_CLIENT_SECRET='<the secret value>' ./setup.sh sign-in --provider entra \
  --tenant <Directory (tenant) ID> \
  --client-id <Application (client) ID> \
  --allowed-domains acme.com \
  --public-url https://day0.acme.com
```

Any flag left out is asked for; the secret is asked for in a hidden prompt
when it is not in the environment, and is never a flag. The verb derives the
issuer, `https://login.microsoftonline.com/<tenant>/v2.0`, writes the
customer-local block of `.env.local` with a generated session secret, pushes
the values to the backend, restarts it, and runs `pnpm check:setup`, exiting
with its status. Then build and start the app again (`pnpm build`, then
`pnpm start` behind the proxy): the browser reads the profile at build.

## 7. What the live check must show

With the customer's IT, and a test person assigned in step 4:

```bash
pnpm check:sign-in
```

It prints a one-time link. Open it in a private window and sign in as the test
person. The page and the terminal then show one line per claim, and every line
must be `pass`:

| Claim | Must be |
|---|---|
| `iss` | `https://login.microsoftonline.com/<tenant>/v2.0`, byte for byte |
| `aud` | the client id |
| `sub` | present (the person, as Day0 keys them) |
| `email` | the person's address, in an allowed domain |
| `xms_edov` | `true` (a `note` if you rely on `DAY0_OIDC_EMAIL_TRUSTED` instead) |
| `tid` | the tenant id |
| `exp` | the token's lifetime, an hour by default |
| `refresh_token` | granted |
| `whoAmI` | the owner key the backend derived: the backend fetched the tenant's keys and accepted the token |

Keep the output (`pnpm check:sign-in --report` prints a JSON copy with the
claim names and verdicts and no values) with the install's support bundle,
`pnpm --silent check:setup --report`.
