# The way out: Day0 behind your HTTP proxy

Day0 reaches out of the machine it runs on: to the model, to the systems an
approved card names, to the documentation sources you link, and on a first
start to the registries its components are fetched from. This page lists
every host by what needs it, says how to send that traffic through your
HTTP proxy where the network allows no direct route, and says what each
part of Day0 did with a proxy when one was the only way out.

It was written from a test bed on 13 October 2026 on which no container had
a route to the internet but a forward proxy, which logged who asked for
what. Where a line below was read from the code and not run there, it says
so.

## Naming the proxy

In `.env.local`, by the names every HTTP client already reads:

```bash
HTTPS_PROXY=http://proxy.acme.com:3128
HTTP_PROXY=http://proxy.acme.com:3128
NO_PROXY=day0.acme.com,convex.day0.acme.com,login.acme.com
NODE_USE_ENV_PROXY=
```

- `HTTPS_PROXY` carries everything Day0 sends to a vendor, since every one
  is reached over https. `HTTP_PROXY` is for a plain-http request; set it
  to the same address, so a client that asks for it finds one.
- `NO_PROXY` lists **your own** hosts that the proxy does not serve,
  separated by commas: Day0's two public names and your identity provider
  where they are inside the network, and every host `DAY0_PRIVATE_HOSTS`
  names. A leading dot or `*.` covers a whole domain (`.acme.com`).
- `NODE_USE_ENV_PROXY` is Node's own switch for reading the three. Leave it
  empty: Day0 turns it on wherever `HTTPS_PROXY` is set.

You never list Day0's own services or this machine: `localhost`,
`127.0.0.1` and every service one container dials by name are always kept
out of the proxy, listed or not.

Set the four before `./setup.sh install`, which then runs every step
through the proxy. On an install that is already running, write them and
run `./setup.sh resume`: it starts the services again with them, puts
`NO_PROXY` on the deployment (below), restarts the backend and ends on
`pnpm check:setup`. Then start the app again (`pnpm start`).

Node reads a proxy from its environment from 22.21.0 on the 22 line (24 or
later after it). The setup, `pnpm start` and the Slack socket bridge each
say so, by the version they found, where a proxy is named and their Node
is older; `pnpm start` then starts nothing, since an app that ignored the
proxy would meet your network as timeouts with no cause.

The bed's proxy was a plain `http://` address with no sign-in. An address
that carries a user and password is printed by its host and port only;
none was run on the bed.

## What takes the proxy

| What | How it is given the proxy | On the bed |
|---|---|---|
| The backend's own program (your identity provider's keys) | the container's environment (`docker compose`, from `.env.local`) | with the issuer left out of `NO_PROXY`: three `CONNECT`s for it at the proxy from the backend's address, and the sign-in completed. With it listed: none |
| An action in Convex's default runtime | the same | a probe's `fetch` answered 200 through the proxy. Day0 itself makes no request from that runtime |
| A Node action: the model, the systems an approved card reaches, the documentation readers | the proxy from the container's environment, `NO_PROXY` from the deployment's own variables | a charter was drafted with `CONNECT api.featherless.ai:443` at the proxy from the backend's address |
| The app (`pnpm start`): the model for the one-to-one | `pnpm start` reads `.env.local` and starts Node with it | `CONNECT api.featherless.ai:443` from this machine at each turn |
| The setup and the three checks (`pnpm check:setup`, `check:access`, `check:sign-in`), and what they start | each starts itself with it, run by hand or by the setup | the install passed end to end; a check from a plain shell passed, with no request for this machine's backend at the proxy |
| The Slack socket bridge | the container's environment | its start line said "wayOut: the proxy at ..."; a request from it reached out through the proxy and found no route with Node's switch off. No employee's app had an app-level token on the bed, so no socket to Slack was opened there: that the socket tunnels is held by a test against a proxy double |
| The redactor (its wheels and model, on a first start) | the container's environment | a request from its Python reached out by its environment and not without it. Its first-start downloads were not repeated: the bed's volumes were warm |
| Nango's server (the token store) | the container's environment | not started on the bed |
| `pnpm check:access`'s `reach` row (a request from inside the backend container) | the container's environment | the row passed, and its request was in the proxy's log |

**The one thing to know about the backend.** It runs each Node action with
the deployment's variables in place of the container's. The proxy survives
that, and `NO_PROXY` does not: on the bed, before the deployment held it,
every call a Node action made back to the backend at `127.0.0.1` went to
the proxy and was refused there, five in twenty seconds. So `pnpm sync:env`
puts `NO_PROXY` on the deployment whenever `.env.local` names a proxy
(Day0's own names first, then yours), and `pnpm check:setup` is a gap,
naming what is missing, when the deployment lacks a name. After you change
`NO_PROXY`: `pnpm sync:env`, then `pnpm convex:restart`. Nothing in the
backend's image was changed for any of this, and nothing has to be reached
directly on its account.

## What does not take the proxy

Read from the code and the compose file; none of these was run on the bed.

- **A git documentation source on a host you list** (`DAY0_GIT_HOSTS`). Its
  clone dials the host at the address Day0 resolved for it and with every
  proxy variable removed, which is what keeps a listed host from being
  pointed somewhere else. On a network whose only way out is the proxy it
  needs a direct route to that host. A git server inside your network
  (`DAY0_PRIVATE_HOSTS`) needs none.
- **A git documentation source on `github.com` or `gitlab.com`: not
  established.** Day0 clones first, and the clone is a `git` process started
  with the deployment's variables, which hold `NO_PROXY` and not the
  proxy's address, so it would dial directly. Where that fails for a public
  repository, Day0 downloads the repository's archive with a request of its
  own, which takes the proxy as every Node action's does; a repository read
  with a secret has no second way. Whether such a source syncs with the
  proxy as the only way out was not run; allow a direct route to the host
  until it has been.
- **The Notion documentation component** (`--profile docs-notion`), which
  fetches its package from `registry.npmjs.org` on its first start and
  calls `api.notion.com`, and **the browser component** (`--profile
  browser`). Neither is handed the proxy. A Notion source needs a direct
  route for that container to those two hosts; the browser reaches the
  systems inside your network, and one on the internet needs a direct
  route.
- **The bundled model service** (`--profile model`, the local-model way
  only), which pulls its model from `registry.ollama.ai`. It is not handed
  the proxy.
- **Docker itself**: the image pulls and the backend image's build are the
  daemon's, by its own proxy settings (Docker's documentation, "Configure
  the daemon to use a proxy").
- **`pnpm install` run by hand**, which reads a proxy from the shell it runs
  in or from `.npmrc`. The one `./setup.sh upgrade` runs is handed the proxy
  `.env.local` names, as every child of the setup is.

Next.js's own usage telemetry is turned off for the build and for the app
(`pnpm build` and `pnpm start` set `NEXT_TELEMETRY_DISABLED=1` before Next
starts): before that, the bed's proxy logged `telemetry.nextjs.org` from the
machine, a host nobody had listed.

## The hosts

`pnpm check:setup` prints this list for your configuration under "The way
out", and `pnpm check:setup --report` carries it as `egress`: only the
hosts your settings and your organisation's connections name. All of them,
by what needs each:

| Host | What needs it |
|---|---|
| your model's host (`api.openai.com`, `api.featherless.ai`, or the one `OPENAI_BASE_URL` names) | the model: the app for the one-to-one, the backend for the charter, plans and skills |
| `registry.modelcontextprotocol.io` | orientation, looking up a system's MCP server |
| `mcp.linear.app` | Linear intake and writes, once a Linear card is approved |
| `slack.com` | Slack intake and posts, once a Slack card is approved |
| `wss-primary.slack.com` | the Slack socket bridge's connections over `wss://`. Slack picks the host for each connection and may change it; this is the one seen in October 2026 |
| `github.com`, `gitlab.com`, a host in `DAY0_GIT_HOSTS` | a git documentation source, when one is linked (see above: a listed host directly, the other two not established) |
| `open.feishu.cn`, `open.larksuite.com` | a Feishu documentation source, by its region |
| `api.atlassian.com` | a Confluence Cloud documentation source |
| `login.microsoftonline.com`, `graph.microsoft.com`, your own `<tenant>.sharepoint.com` | a SharePoint documentation source |
| `login.chinacloudapi.cn`, `microsoftgraph.chinacloudapi.cn`, your own `<tenant>.sharepoint.cn` | a SharePoint documentation source on the cloud 21Vianet operates |
| `www.yuque.com`, or a space's own `<space>.yuque.com` | a Yuque documentation source |
| `oauth2.googleapis.com`, `www.googleapis.com` | a Google Drive documentation source |
| `api.notion.com` | the Notion documentation component, when a Notion source is linked (directly: see above) |
| `huggingface.co` | the redactor's model snapshot, on its first start |
| `pypi.org`, `files.pythonhosted.org`, `download.pytorch.org` | the redactor's wheels, on its first start |
| `registry.npmjs.org` | the Notion component's pinned package, on its first start (directly: see above) |
| `registry.ollama.ai` | model pulls, with the bundled model service only (directly: see above) |
| `app.daytona.io`, or the one `DAYTONA_API_URL` names | the hosted sandbox, when `DAYTONA_API_KEY` is set |
| `api.elevenlabs.io` | the voice one-to-one, when it is set up |
| your identity provider | discovery, keys and tokens, from this machine and from the backend |
| each connected system's own hosts, and an MCP server's and its authorisation server's | the organisation's connections |
| `registry-1.docker.io`, `ghcr.io`, `mcr.microsoft.com` | image pulls at setup (Docker's own) |
| `archive.ubuntu.com`, `security.ubuntu.com` (`ports.ubuntu.com` on arm64) | the backend image's build at setup and upgrade, over http on port 80 (Docker's own) |

The systems an approved card reaches are the ones your documentation
names; they join the list as their connections land.

## When something is refused

| You see | Do |
|---|---|
| `GAP The way out`, "The deployment does not hold every name NO_PROXY keeps out" | `pnpm sync:env`, then `pnpm convex:restart` |
| `GAP The way out`, "this Node ... does not read one from the environment" | run Day0's commands on Node 22.21.0 or later |
| "The issuer cannot be reached from inside the backend container" | where your identity provider is inside the network, list it in `NO_PROXY`; where it is outside, allow it at the proxy |
| `reach` GAP from `pnpm check:access` | allow the vendor's host at the proxy. Where the proxy re-signs https with your own authority, give the backend container that authority's bundle ([the install runbook](install.md), step 6) |
| a documentation source that never syncs | find its host in the list above; a Notion source and a git source on a host you list need a direct route |
| a proxy's log showing a host this page does not name | tell us: the list is meant to be complete |
