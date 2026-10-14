# The way out: Day0 behind your HTTP proxy

Day0 reaches out of the machine it runs on: to the model, to the systems an
approved card names, to the documentation sources you link, and on a first
start to the registries its components are fetched from. This page lists
every host by what needs it, says how to send that traffic through your
HTTP proxy where the network allows no direct route, and says what each
part of Day0 did with a proxy when one was the only way out.

It was written from two test beds, on 13 and 14 October 2026, on which no
container had a route to the internet but a forward proxy, which logged who
asked for what; the second ran an authenticating proxy too. Where a line
below was read from the code and not run there, it says so.

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
- A proxy that asks for a user and password is named with them:
  `http://user:password@proxy.acme.com:3128`. On the second bed the backend
  (its program, its Node actions and a `git` clone), the app, the setup and
  the checks, the Slack socket bridge, the redactor and the Notion component
  each carried them, and Day0 prints the address by its host and port only. `pnpm sync:env` puts the address on the
  deployment (below), which holds it as it holds Day0's other keys.
- `NO_PROXY` lists **your own** hosts that the proxy does not serve,
  separated by commas: Day0's two public names and your identity provider
  where they are inside the network, and every host `DAY0_PRIVATE_HOSTS`
  names. It is read as Node reads it, which is narrower than some clients:
  a name keeps out that name only (`acme.com` does not keep out
  `day0.acme.com`); a leading dot or `*.` keeps out the names under it
  (`.acme.com`), and Node's `fetch` does not count the domain itself among
  them, so list both (`acme.com,.acme.com`) to keep out a domain and every
  name under it; a port narrows an entry to that port; an address range
  (`10.0.0.0/8`) is not read at all. `pnpm check:setup` reads it the same
  way, names each of your own hosts it would send through the proxy, and
  says when a bare domain keeps out only itself.
- `NODE_USE_ENV_PROXY` is Node's own switch for reading the three. Leave it
  empty: Day0 turns it on wherever `HTTPS_PROXY` is set. Set to `0` beside a
  proxy, it is a gap in `pnpm check:setup`: the services would go out
  directly.

You never list Day0's own services or this machine: `localhost`,
`127.0.0.1` and every service one container dials by name are always kept
out of the proxy, listed or not.

Name the proxy in `.env.local` and nowhere else: since 0.22.0 Day0 reads
it from there alone. A proxy exported in the shell, as a corporate
profile's `export HTTPS_PROXY=...` does, reaches no process Day0 starts, no
container and not the deployment, nor does a `NO_PROXY` the shell exports
(list your own hosts in the file's); `pnpm check:setup`, the setup's verbs
and `pnpm start` each say so first: "The shell names a proxy (HTTPS_PROXY)
that .env.local does not. Day0 reads .env.local only, so it goes out
directly". pnpm itself still reads the shell, and with
`NODE_USE_ENV_PROXY=1` exported it prints Node's "EnvHttpProxyAgent is
experimental" warning before Day0's code starts; Day0's own processes are
started with that warning turned off. In such a shell:
`unset HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_USE_ENV_PROXY https_proxy http_proxy no_proxy`.

Set the four before `./setup.sh install`, which then runs every step
through the proxy, and name the proxy once it answers from the machine's
containers: one named before it does fails the model check, "The backend
container has no route to" the model's host, and the install or upgrade
stops on that gap until it answers. On an install that is already running,
write them and run `./setup.sh resume`: it starts every service again with
them, puts `NO_PROXY` and the proxy's address on the deployment (below),
restarts the backend and ends on `pnpm check:setup`. Then start the app
again (`pnpm start`).

Node reads a proxy from its environment from 22.21.0 on the 22 line (24 or
later after it). The setup, `pnpm start` and the Slack socket bridge each
say so, by the version they found, where a proxy is named and their Node
is older; `pnpm start` then starts nothing, since an app that ignored the
proxy would meet your network as timeouts with no cause.

## What takes the proxy

| What | How it is given the proxy | On the beds |
|---|---|---|
| The backend's own program (your identity provider's keys) | the container's environment (`docker compose`, from `.env.local`) | with the issuer left out of `NO_PROXY`: three `CONNECT`s for it at the proxy from the backend's address, and the sign-in completed. With it listed: none |
| An action in Convex's default runtime | the same | a probe's `fetch` answered 200 through the proxy. Day0 itself makes no request from that runtime |
| A Node action: the model, the systems an approved card reaches, the documentation readers | the proxy from the container's environment, `NO_PROXY` from the deployment's own variables | a charter was drafted with `CONNECT api.featherless.ai:443` at the proxy from the backend's address, on both beds |
| A git documentation source on `github.com` or `gitlab.com` | the `git` a Node action starts runs with the deployment's variables, which hold the proxy's address since 0.22.0 | a public repository synced with one `CONNECT github.com:443` from the backend: the clone itself. With the address taken off the deployment, the clone found no route and the source fell back to the repository's archive (`codeload.github.com`); a repository read with a secret has no such second way |
| The app (`pnpm start`): the model for the one-to-one | `pnpm start` reads `.env.local` and starts Node with it | `CONNECT api.featherless.ai:443` from this machine at each turn, through the authenticating proxy too |
| The setup and the three checks (`pnpm check:setup`, `check:access`, `check:sign-in`), and what they start | each starts itself with it, run by hand or by the setup | the install passed end to end on both beds, the second through the authenticating proxy with no warning line; a check from a plain shell passed, with no request for this machine's backend at the proxy |
| The Slack socket bridge | the container's environment | a socket opened by an app-level token on a test double of Slack: the backend's `apps.connections.open` and the bridge's WebSocket each a `CONNECT` at the proxy, the bridge "connected"; again through the authenticating proxy |
| The redactor (its wheels and model, on a first start) | the container's environment | its first start on empty volumes took 2 min 6 s and 2.3 GB, every request through the proxy (the hosts below) |
| The Notion documentation component (`--profile docs-notion`) | the container's environment, since 0.22.0 | its first start fetched its package from `registry.npmjs.org` through the proxy and was healthy in 6 s; a Notion source's calls reached `api.notion.com` through it |
| Nango's server (the token store) | the container's environment | its own API calls take it, by its code; its OAuth token requests do not (below) |
| The browser component (`--profile browser`) and the bundled model service (`--profile model`) | the container's environment, since 0.22.0 | not run on a bed |
| `pnpm check:access`'s `reach` row (a request from inside the backend container) | the container's environment | the row passed, and its request was in the proxy's log |

**The one thing to know about the backend.** It runs each Node action with
the deployment's variables in place of the container's. The proxy survives
that, and `NO_PROXY` does not: on the first bed, before the deployment held
it, every call a Node action made back to the backend at `127.0.0.1` went
to the proxy and was refused there, five in twenty seconds. So
`pnpm sync:env` puts `NO_PROXY` on the deployment whenever `.env.local`
names a proxy (Day0's own names first, then yours), and the proxy's address
beside it, which a `git` the action starts reads; `pnpm check:setup` is a
gap, naming what is missing, when the deployment lacks a name or the
address. After you change `NO_PROXY` in `.env.local`: `./setup.sh resume`,
which creates the containers again with the new list and puts it on the
deployment; a restart of the backend alone keeps the list its container was
created with. Nothing in the backend's image was changed for any of this,
and nothing has to be reached directly on its account.

## What does not take the proxy

- **A git documentation source on a host you list** (`DAY0_GIT_HOSTS`). Its
  clone dials the host at the address Day0 resolved for it and with every
  proxy variable removed, which is what keeps a listed host from being
  pointed somewhere else. On the second bed such a source said "The git
  host codeberg.org did not resolve." and nothing reached the proxy: on a
  network whose only way out is the proxy, the backend needs a name server
  and a direct route to that host. A git server inside your network
  (`DAY0_PRIVATE_HOSTS`) needs none.
- **Nango's token requests.** Nango's server (`--profile token-store`)
  exchanges and refreshes the OAuth tokens it keeps through its own
  connections, which pin the address they resolved and take no proxy (its
  `getSafeHttpAgents`, by the pinned image's code). On the second bed a
  refresh failed in 14 ms with nothing at the proxy. A system whose tokens
  Nango keeps needs a direct route from `nango-server` to that provider's
  token endpoint. Its other calls take the proxy.
- **Docker itself**: the image pulls and the backend image's build are the
  daemon's, by its own proxy settings (Docker's documentation, "Configure
  the daemon to use a proxy").
- **`pnpm install` run by hand**, which reads a proxy from the shell it runs
  in or from `.npmrc`. The one `./setup.sh upgrade` runs is handed the proxy
  `.env.local` names, as every child of the setup is.

Next.js's own usage telemetry is turned off for the build and for the app
(`pnpm build` and `pnpm start` set `NEXT_TELEMETRY_DISABLED=1` before Next
starts): before that, the first bed's proxy logged `telemetry.nextjs.org`
from the machine, a host nobody had listed.

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
| `github.com`, `gitlab.com`, a host in `DAY0_GIT_HOSTS` | a git documentation source, when one is linked (see above: a listed host directly) |
| `open.feishu.cn`, `open.larksuite.com` | a Feishu documentation source, by its region |
| `api.atlassian.com` | a Confluence Cloud documentation source |
| `login.microsoftonline.com`, `graph.microsoft.com`, your own `<tenant>.sharepoint.com` | a SharePoint documentation source |
| `login.chinacloudapi.cn`, `microsoftgraph.chinacloudapi.cn`, your own `<tenant>.sharepoint.cn` | a SharePoint documentation source on the cloud 21Vianet operates |
| `www.yuque.com`, or a space's own `<space>.yuque.com` | a Yuque documentation source |
| `oauth2.googleapis.com`, `www.googleapis.com` | a Google Drive documentation source |
| `api.notion.com` | the Notion documentation component, when a Notion source is linked |
| `huggingface.co` | the redactor's model snapshot, on its first start |
| `cas-server.xethub.hf.co`, `us.aws.cdn.hf.co` | the redactor's model files, on its first start. Hugging Face's storage picks the hosts; these are the ones seen in October 2026 |
| `pypi.org`, `files.pythonhosted.org`, `download.pytorch.org`, `download-r2.pytorch.org` | the redactor's wheels, on its first start (`download.pytorch.org` sends torch's on to `download-r2.pytorch.org`) |
| `registry.npmjs.org` | the Notion component's pinned package, on its first start |
| `registry.ollama.ai` | model pulls, with the bundled model service only |
| `app.daytona.io`, or the one `DAYTONA_API_URL` names | the hosted sandbox, when `DAYTONA_API_KEY` is set |
| `api.elevenlabs.io` | the voice one-to-one, when it is set up |
| your identity provider | discovery, keys and tokens, from this machine and from the backend |
| each connected system's own hosts, and an MCP server's and its authorisation server's | the organisation's connections (a system whose tokens Nango keeps: its token endpoint directly, see above) |
| `registry-1.docker.io`, `ghcr.io`, `mcr.microsoft.com` | image pulls at setup (Docker's own) |
| `archive.ubuntu.com`, `security.ubuntu.com` (`ports.ubuntu.com` on arm64) | the backend image's build at setup and upgrade, over http on port 80 (Docker's own) |

The systems an approved card reaches are the ones your documentation
names; they join the list as their connections land.

## When something is refused

| You see | Do |
|---|---|
| `GAP The way out`, "The deployment does not hold every name NO_PROXY keeps out" | `pnpm sync:env`; where you changed `NO_PROXY` in `.env.local`, `./setup.sh resume` |
| `GAP Model`, "The backend container has no route to" the model's host, with a proxy named | the proxy does not answer from the containers yet: check its address from the machine, or take the three names out of `.env.local` until it does |
| `GAP The way out`, "this Node ... does not read one from the environment" | run Day0's commands on Node 22.21.0 or later |
| `note The way out`, "The shell names a proxy (...) that .env.local does not" | name the proxy in `.env.local` (and `./setup.sh resume`), or unset it in the shell |
| "NO_PROXY keeps out acme.com only: write .acme.com to keep out every name under it." | list the domain and the names under it: `acme.com,.acme.com` |
| `GAP The way out`, ".env.local turns Node's proxy switch off while it names a proxy" | empty `NODE_USE_ENV_PROXY` in `.env.local`, then `./setup.sh resume` |
| `GAP The way out`, "The deployment does not hold the proxy's address as .env.local names it" | `pnpm sync:env` |
| "The issuer cannot be reached from inside the backend container" | where your identity provider is inside the network, list it in `NO_PROXY`; where it is outside, allow it at the proxy |
| `reach` GAP from `pnpm check:access` | allow the vendor's host at the proxy. Where the proxy re-signs https with your own authority, give the backend container that authority's bundle ([the install runbook](install.md), step 6) |
| a documentation source that never syncs | find its host in the list above; a git source on a host you list needs a direct route |
| a token Nango keeps that stops refreshing | allow `nango-server` a direct route to that provider's token endpoint |
| a proxy's log showing a host this page does not name | tell us: the list is meant to be complete |
