# The company sign-in with Okta

Day0 installed at a customer signs people in through the customer's own
identity provider: their managers use their work accounts, and nobody signs in
whom the customer's IT has not let in. This guide is what we run with the
customer's Okta administrator, once, after `./setup.sh --route ...` has set
Day0 up on the customer's machine. The Entra, Google and generic OpenID Connect
guides follow the same seven steps: [sign-in-entra.md](sign-in-entra.md),
[sign-in-google.md](sign-in-google.md), [sign-in-oidc.md](sign-in-oidc.md).

Before you start you need:

- the address people will reach Day0 on, through the customer's reverse
  proxy, as an `https` origin with no path, such as `https://day0.acme.com`.
  It is `DAY0_PUBLIC_URL`;
- an Okta administrator who can create app integrations and assign them;
- to know **which authorisation server** the customer uses. Okta has two
  kinds: the **org** authorisation server, whose issuer is the Okta domain
  itself (`https://acme.okta.com`), and **custom** ones, whose issuer is
  `https://acme.okta.com/oauth2/<id>` (`default` is the one Okta creates).
  Ask; most customers without API Access Management use the org server;
- outbound https from this machine **and from the backend container** to the
  Okta domain. The backend fetches Okta's signing keys itself, and a
  container does not inherit the host's proxy settings, so a firewall that
  admits the host and not the container refuses every sign-in.
  `pnpm check:setup` tests both.

## 1. Register the application

In the Okta Admin Console, **Applications > Applications > Create App
Integration**: sign-in method **OIDC - OpenID Connect**, application type
**Web Application**. Name it Day0. Under *Grant type*, keep **Authorization
Code** and tick **Refresh Token**.

## 2. The redirect URI

| Field | Value |
|---|---|
| Sign-in redirect URIs | `https://day0.acme.com/api/auth/oidc/callback` |
| Sign-out redirect URIs | `https://day0.acme.com/api/auth/oidc/logout` |

Use the customer's `DAY0_PUBLIC_URL` in place of `https://day0.acme.com`; the
setup verb prints both URIs exactly.

## 3. Scopes and claims

Day0 asks for `openid profile email offline_access`. The `email` scope brings
`email` and `email_verified`, which Day0 needs to believe a manager's address;
`offline_access` brings the refresh token that keeps a session going past the
ID token. On a **custom** authorisation server, check under **Security > API >
Authorization Servers > <server> > Access Policies** that a rule admits the
Day0 app with the *Authorization Code* and *Refresh Token* grants and these
scopes.

If the customer's Okta sends no `email_verified`, and every address it issues
is one it controls, set `DAY0_OIDC_EMAIL_TRUSTED=true`: the declared fallback
(decision D3). Without either, a person signs in and cannot deploy an employee
or take one on.

## 4. Who may sign in

Three things decide it, and the first is the customer's:

1. **Okta's assignment.** On the app's **Assignments** tab, assign the
   managers, or a group of them. Under *General > User consent* leave consent
   off. Anyone unassigned is refused by Okta before Day0 sees them.
2. **The allowed domains**, `DAY0_OIDC_ALLOWED_DOMAINS`: the email domains
   whose people may sign in, such as `acme.com`. Day0 checks the token's
   `email` at the callback and again on the backend.
3. **A verified address** (step 3), which deploying and taking on an employee
   need.

## 5. The secret and its expiry

On the app's **General** tab, *Client Credentials*: keep **Client secret** as
the authentication method (Day0 sends it with HTTP Basic, Okta's default) and
copy the secret. Okta secrets do not expire on their own; the customer's policy
may rotate them. Note who holds it and when it was made. To rotate it, generate
a new secret, run `./setup.sh sign-in` again with the new value (everything
else is kept, nobody is signed out), then deactivate the old one.

## 6. What to hand to the setup verb

On the customer's machine, in the Day0 checkout:

```bash
./setup.sh sign-in --provider okta \
  --okta-domain acme.okta.com \
  --auth-server org \
  --client-id <Client ID> \
  --allowed-domains acme.com \
  --public-url https://day0.acme.com
```

`--auth-server` is `org`, `default` or the custom server's id. The client
secret is asked for in a hidden prompt, never on the command line, where it
would stay in the shell's history; any flag left out is asked for too. The verb
derives the issuer, writes the customer-local block of `.env.local` with a
generated session secret, pushes the values to the backend, restarts it, and
runs `pnpm check:setup`, exiting with its status. Then build and start the app
again (`pnpm build`, then `pnpm start` behind the proxy): the browser reads the
profile at build.

## 7. What the live check must show

With the customer's IT, and a test person assigned in step 4:

```bash
pnpm check:sign-in
```

It prints a link good for ten minutes. Open it in a private window and sign in as the test
person. The page and the terminal then show one line per claim, and every line
must be `pass`:

| Claim | Must be |
|---|---|
| `iss` | `https://acme.okta.com` or `https://acme.okta.com/oauth2/<id>`, byte for byte |
| `aud` | the client id |
| `sub` | present (the person, as Day0 keys them) |
| `email` | the person's address, in an allowed domain |
| `email_verified` | `true` (a `note` if you rely on `DAY0_OIDC_EMAIL_TRUSTED` instead) |
| `exp` | the token's lifetime, an hour by default |
| `refresh_token` | granted |
| `whoAmI` | the owner key the backend derived: the backend fetched Okta's keys and accepted the token |

Keep the output (`pnpm check:sign-in --report` prints a JSON copy with the
claim names and verdicts and no values) with the install's support bundle,
`pnpm --silent check:setup --report`.
