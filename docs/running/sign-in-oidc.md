# The company sign-in with any other OpenID Connect issuer

Day0 installed at a customer signs people in through the customer's own
identity provider: their managers use their work accounts, and nobody signs in
whom the customer's IT has not let in. This guide is what we run with the
administrator of an issuer that is not Entra, Okta or Google (Keycloak,
Authentik, Ping, Auth0 and the like), once, after `./setup.sh --route ...` has
set Day0 up on the customer's machine. It follows the same seven steps as the
Entra, Okta and Google guides: [sign-in-entra.md](sign-in-entra.md),
[sign-in-okta.md](sign-in-okta.md), [sign-in-google.md](sign-in-google.md).

Before you start you need:

- the address people will reach Day0 on, through the customer's reverse
  proxy, as an `https` origin with no path, such as `https://day0.acme.com`.
  It is `DAY0_PUBLIC_URL`;
- an administrator of the issuer who can register a client and decide who may
  use it;
- **the issuer's URL exactly as its tokens carry it** in `iss`, with or
  without a trailing slash as the issuer writes it. Its discovery document must
  answer at `<issuer>/.well-known/openid-configuration`; open it in a browser
  and copy `issuer` from it;
- outbound https from this machine **and from the backend container** to the
  issuer. The backend fetches the issuer's signing keys itself, and a
  container does not inherit the host's proxy settings, so a firewall that
  admits the host and not the container refuses every sign-in.
  `pnpm check:setup` tests both.

## 1. Register the application

In the issuer's administration console, create a client for Day0: a
**confidential** client (one that holds a secret) using the **authorization
code** flow with **PKCE** (`S256`), allowed to receive **refresh tokens**.
Name it Day0. Leave implicit and hybrid flows off.

## 2. The redirect URI

| Field | Value |
|---|---|
| Redirect (callback) URI | `https://day0.acme.com/api/auth/oidc/callback` |
| Post-logout redirect URI | `https://day0.acme.com/api/auth/oidc/logout` |

Use the customer's `DAY0_PUBLIC_URL` in place of `https://day0.acme.com`; the
setup verb prints both URIs exactly. If the issuer's discovery document names
no `end_session_endpoint`, signing out of Day0 ends the Day0 session and leaves
the issuer's own session as it was.

## 3. Scopes and claims

Day0 asks for `openid profile email offline_access`. The `email` scope must
bring `email` and `email_verified`, which Day0 needs to believe a manager's
address; `offline_access` (or whatever the issuer calls the grant of a refresh
token) brings the refresh token that keeps a session going past the ID token.
Check that the issuer puts `email` and `email_verified` in the **ID token**,
not only at its userinfo endpoint: Day0 reads the ID token.

If the issuer sends no `email_verified`, and every address it issues is one it
controls, set `DAY0_OIDC_EMAIL_TRUSTED=true`: the declared fallback (decision
D3). Without either, a person signs in and cannot deploy an employee or take
one on.

## 4. Who may sign in

Three things decide it, and the first is the customer's:

1. **The issuer's own access rule.** Limit the Day0 client to the managers, or
   a group of them, by whatever the issuer calls it (a role, a group, an
   application assignment). Anyone the issuer refuses never reaches Day0.
2. **The allowed domains**, `DAY0_OIDC_ALLOWED_DOMAINS`: the email domains
   whose people may sign in, such as `acme.com`. Day0 checks the token's
   `email` at the callback and again on the backend.
3. **A verified address** (step 3), which deploying and taking on an employee
   need.

**Self-registration.** Under this preset Day0 admits only a *verified* address:
the issuer's `email_verified` must be `true` (or, for an issuer that sends no
such claim, `DAY0_OIDC_EMAIL_TRUSTED=true` declares its addresses verified).
A person whose address the issuer did not verify is refused at sign-in, with
words that say so, and again by the backend. Entra, Okta and Google control
the addresses they issue; an issuer of this kind may let anyone register one
and verify it themselves. **Where anyone can register and verify an address at
this issuer, turn self-registration off**: otherwise someone who registers
`anyone@acme.com` there signs in to Day0 and can spend the model.
`pnpm check:sign-in` says so on its `registration` line for every issuer of
this kind (decision 7 (a), with 7 (b) built in v0.14.0).

## 5. The secret and its expiry

Copy the client's secret. Day0 sends it with HTTP Basic
(`client_secret_basic`), the standard's default; set the client's token
endpoint authentication to that method if the issuer asks. Find out whether
the issuer expires client secrets, and if it does, put the date in the
customer's calendar now: an expired secret signs every manager out at their
next refresh. Note who holds it and when it was made. To rotate it, make a new
secret, run `./setup.sh sign-in` again with the new value (everything else is
kept, nobody is signed out), then remove the old one.

## 6. What to hand to the setup verb

On the customer's machine, in the Day0 checkout:

```bash
./setup.sh sign-in --provider oidc \
  --issuer https://id.acme.com/realms/acme \
  --client-id <client id> \
  --allowed-domains acme.com \
  --public-url https://day0.acme.com
```

`--issuer` is the issuer's URL from the discovery document, byte for byte. The
client secret is asked for in a hidden prompt, never on the command line, where
it would stay in the shell's history; any flag left out is asked for too. The
verb writes the customer-local block of `.env.local` with a generated session
secret, pushes the values to the backend, restarts it, and runs
`pnpm check:setup`, exiting with its status. Then build and start the app
again (`pnpm build`, then `pnpm start` behind the proxy): the browser reads the
profile at build.

## 7. What the live check must show

With the customer's IT, and a test person let in at step 4:

```bash
pnpm check:sign-in
```

It prints a link good for ten minutes. Open it in a private window and sign in as the test
person. The page and the terminal then show one line per claim, and every line
must be `pass` but the `registration` line, which is a `note` on every issuer
of this kind:

| Claim | Must be |
|---|---|
| `iss` | the issuer's URL, byte for byte |
| `aud` | the client id |
| `sub` | present (the person, as Day0 keys them) |
| `email` | the person's address, in an allowed domain |
| `email_verified` | `true` (a `note` if you rely on `DAY0_OIDC_EMAIL_TRUSTED` instead) |
| `registration` | a `note`: confirm with the customer's IT that nobody can register and verify an address in an allowed domain themselves (step 4) |
| `exp` | the token's lifetime |
| `refresh_token` | granted |
| `whoAmI` | the owner key the backend derived: the backend fetched the issuer's keys and accepted the token |

Keep the output (`pnpm check:sign-in --report` prints a JSON copy with the
claim names and verdicts and no values) with the install's support bundle,
`pnpm --silent check:setup --report`.
