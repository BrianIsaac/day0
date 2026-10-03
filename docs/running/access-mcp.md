# Connect an MCP server for the organisation

This is the recipe we run with the customer's IT for a system the
documentation reaches through an MCP server that asks for OAuth (the server
answers `401` with a `WWW-Authenticate` challenge). It runs during the install
(`./setup.sh access`, or `./setup.sh install`; the runbook is
[install.md](install.md)), once per server. A server the documentation names
by an address ending in `/mcp` or `/sse` is listed by the verb; any other is
named with `--systems https://<the server's address>`.

An MCP server is connected **per employee**: IT registers Day0 as a client of
the server's authorisation server once, and each employee's card then
authorises through its manager's own browser, so the server sees the
manager's delegated consent for that employee.

## 1. What IT creates

A **client registration** for Day0 at the server's authorisation server,
registered by IT ahead of time. Day0 does not register itself, even where the
server offers dynamic registration: IT registers the client, by the server's
form or by its registration endpoint, and hands Day0 its id. The
registration:

- client type: a confidential client with a secret, or a public client (Day0
  uses PKCE either way);
- redirect URI: `${DAY0_PUBLIC_URL}/api/oauth/mcp`, exactly;
- grant types: authorisation code, with refresh tokens;
- the scopes the employees' work needs, and no more.

## 2. The manifest or the form

There is no manifest: the authorisation server's own client form takes the
values in step 1. Note the **client id**, and for a confidential client the
**client secret** and the **issuer** URL of the authorisation server it was
registered with: Day0 sends the secret to that server alone, and refuses a
secret landed without its issuer. For a public client the issuer is optional
(Day0 otherwise discovers it from the MCP server's resource metadata at the
first authorisation).

## 3. The scopes

The registration's scopes are whatever the server defines; the kit names none
of its own, and the connection holds the list IT gives (none means the
server's offered scopes are asked for).

<!-- access-kit: scopes per-employee -->

```text
```

## 4. The allow-list

Many servers keep an allow-list of clients or of redirect URIs. Add Day0's
client id, and `${DAY0_PUBLIC_URL}/api/oauth/mcp` as its redirect, to it. A
server that also restricts which networks may call it must admit the
backend's outbound address.

## 5. The secret and its lifetime

As the authorisation server sets it: ask IT when the client secret expires and keep the date in the install record; a public client has none.

## 6. What to hand to the setup verb

The verb asks for the server's address, the client id, the client secret (in a
hidden prompt; Enter for a public client), the issuer (needed with a secret;
Enter to discover it for a public client) and the scopes (Enter for the
server's own):

```bash
./setup.sh access --systems https://mcp.acme.com/mcp
```

For a scripted install, from a file readable by you alone, on stdin; a secret
is never a command-line flag:

```bash
umask 077
cat > answers.env <<'EOF'
MCP_SERVER_URL=https://mcp.acme.com/mcp
MCP_CLIENT_ID=<the client id>
MCP_CLIENT_SECRET=<the client secret>
MCP_ISSUER=https://auth.acme.com
MCP_SCOPES=crm.read,crm.write
EOF
./setup.sh access --administrators it@acme.com --systems https://mcp.acme.com/mcp --secrets-stdin < answers.env
rm answers.env
```

The connection's system key is `mcp:` and the server's host (`mcp:mcp.acme.com`).
When one run connects several MCP servers from stdin, each server's lines carry
its host, so one server's answers never stand for another's:
`MCP_MCP_ACME_COM_CLIENT_ID=`, `MCP_CRM_ACME_COM_CLIENT_ID=`, and so on for
each name above. A documented MCP address you do not want connected is left out
by naming the systems with `--systems`.

## 7. What check:access must show

`pnpm check:access` prints, for `mcp:<host>`:

| Check | Must be |
|---|---|
| `status` | `pass`: connected, per employee |
| `redirect` | `pass`: the registered redirect is `${DAY0_PUBLIC_URL}/api/oauth/mcp` |
| `scopes` | `pass`: the scopes IT gave, each one the server offers |
| `secret` | `pass`: opens under the deployment's key, or a public client holds none |
| `identity` | `pass`: the authorisation server's metadata names the issuer and a token endpoint; a `note` when no issuer was given, since Day0 discovers it at the first authorisation |
