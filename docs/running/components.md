# Components

Day0 is one program and a handful of optional components. The program is the
backend; each component is one thing day0 cannot do by itself, and you start
only the ones your systems need.

**The one line to decide by:** start a component when your team's documentation
or your systems require it, and leave it out otherwise. Every component you
leave out costs you the systems it reaches and nothing else. Day0 still reads
the documentation, still proposes the path the documentation records, and still
says on the card which component is missing.

Components are compose profiles. `real` is day0 itself and is always on:

```
pnpm convex:up                                                    # day0 alone
pnpm convex:up --profile docs-notion --profile browser            # an enterprise
pnpm convex:up --profile docs-notion --profile browser --profile demo
```

| You have | Start |
|---|---|
| Documentation in a folder, a git repository or on internal URLs; every system has an API or an MCP server | `--profile real` |
| Documentation in Notion, and systems that are reached through a web UI | `--profile real --profile docs-notion --profile browser` |
| The semi-final demo, which adds a synthetic web-UI system to drive | `--profile real --profile docs-notion --profile browser --profile demo` |

`pnpm check:setup` prints which components are running, which ones your linked
documentation depends on, and any half-state: a component configured with
nothing listening, or one running that day0 was never told about.

---

## `backend` - day0 itself

**What it is.** The Convex backend: day0's database and the code that runs in
it. The 1:1 that produces a charter, the orientation run that proposes a
connection, the approval gate, the work loop, the skill author and the ledger
are all here.

**What day0 uses it for.** Everything. It also mounts your documentation folder
read-only, so a folder source needs no other component.

**When you need it.** Always. Nothing runs without it, and every other profile
adds to it.

**When you do not.** Never.

**What it never sees.** It never writes to the documentation folder: the mount
is read-only, which is checked from inside the container by `pnpm check:setup`.
Stored credentials are encrypted with a key that lives in your environment and
never in the database, and no credential value is returned to a page, an event,
a prompt or a ledger row.

---

## `docs-notion-mcp` - the Notion documentation component

**What it is.** Notion's own MCP server, run inside your network. It is named
for the vendor because it is that vendor's software.

**What day0 uses it for.** Reading the team's handbook when the handbook lives
in Notion. Day0 learns your systems, their access paths and the exact shapes of
the actions it may take from those pages, so the pages are the input to almost
everything else.

**Why it is a component rather than a call.** Notion's hosted server signs a
person in with a browser, which a headless deployment cannot do. Running the
vendor's own server yourself is what makes the handbook readable without a
person present, and the connection secret you paste into `/documentation` is
what it reads with.

**When you need it.** Only when a documentation source is a Notion source
pointed at day0's own server. Link it on `/documentation` as kind `mcp`, server
kind `Notion`, location `http://docs-notion-mcp:3000/mcp`.

**When you do not.** A folder, a git repository or a list of URLs needs no
component at all: the backend reads those itself. Nor do the other MCP server
kinds, which reach a server you already run and day0 only dials.

**What it never sees.** Only the pages the Notion connection is shared with. In
Notion you connect the integration to a parent page and nothing outside it is
visible, so the boundary is one you set and can see. Day0 sends your connection
secret in the header that opens one session and closes that session when the
sync ends; the secret is stored encrypted and is never displayed again. Values
the pages themselves declare as credentials are encrypted at sync and replaced
in the agent-readable copy by a marker, so a password written in a handbook does
not reach a prompt, an event or a ledger row.

---

## `playwright-mcp` - the browser component

**What it is.** A browser and the standard server that drives one, run inside
your network. It is named for the vendor because it is that vendor's software.

**Why a browser at all.** Some systems have a web UI and nothing else. No API,
no MCP server, no export endpoint, and no prospect of one. A person who has to
update a figure on such a system signs in and types it. Day0's answer is to do
the same thing, in the open: it drives the same UI a person would, over the
Model Context Protocol, with one isolated browser session per run, and it says
so on the card. The alternative is to pretend such systems do not exist, which
is the gap in every other agent that claims to work with your tools.

**Why this server.** Driving a browser from an agent needs a tool catalogue the
agent can read and an isolated session per run. This is the standard driver that
offers both: day0 reads its live catalogue during the probe rather than assuming
tool names, and its isolated-session mode gives each run its own browser context,
so no run inherits another's cookies or its signed-in page.

**What day0 uses it for.** A `browser-driven` surface, which orientation
proposes only when a page documents a web UI and denies an API. The surface's
allowlist is what a person needs to read a page and complete a form: open a
page, read it, click, type, fill a form. Everything that turns a browser into a
general runtime or a file mover is deliberately absent, including screenshots.

**When you need it.** When any system you use has a web UI and no other way in.

**When you do not.** When every system has an API or an MCP server. Day0 still
proposes `browser-driven` on the evidence, and the card then says the component
is not running and holds approval; the probe, the work loop and intake all
refuse with `BROWSER_DRIVER_ABSENT` rather than a transport error. Nothing is
lost but the systems only a browser can reach.

**What it never sees.** The system's credential as a credential. A browser
driver is not the system, so it is never handed a bearer token. A login reaches
the page the way a person's would, typed into the page's own field, resolved
inside the adapter at the moment of the call and redacted back out of the
ledger. It never appears in a prompt, an event or a ledger row, and there is no
screenshot verb for it to appear in a picture of. The browser also cannot leave
the surface a human approved: navigation is bounded to the documented address
and re-checked against the page it actually landed on, so a redirect elsewhere
is a refusal.

---

## `looker-tile` - the demonstration system

**What it is.** A synthetic system with a web UI, a login, one editable figure
and an audit line. It is not part of day0; it stands in for an enterprise's own
web app.

**What day0 uses it for.** Nothing, in your installation. It exists so the
browser component can be demonstrated against something, and so the browser
floor has a system to be tested against that nobody has to own.

**When you need it.** For the demo, and for a review pane reproducing it.

**When you do not.** In an enterprise. Your own web-UI systems are the real
thing, and this one would only be a fifth card nobody asked for.

**What it never sees.** Anything outside its own container. It has no
credentials of its own beyond the login its documentation page publishes, which
is the point of the exercise: day0 discovers that login from the docs like any
other credential.

---

## `fake-slack` - the provider double

**What it is.** A stand-in for a chat provider's API, used only by tests and
review panes so that a self-provisioning round trip can be proved without
touching a real workspace.

**What day0 uses it for.** Nothing in production. Reaching it at all requires a
development-only setting that is refused outside a local no-auth run.

**When you need it.** Running the test suite's live proofs, or reviewing them.

**When you do not.** Every real installation. A real workspace is reached at the
provider's own address, and the surface row and its evidence name that address.

**What it never sees.** A real workspace, a real token or a real message. It
holds its state in memory and forgets it when the container stops.

---

## `dashboard` - the database dashboard

**What it is.** The Convex dashboard: a web view of the backend's tables,
functions and logs.

**What day0 uses it for.** Nothing. It is for you, when you want to read a row
or a log line directly.

**When you need it.** Debugging, and reading what a run actually stored.

**When you do not.** Normal operation. Day0's own pages show the work, the
surfaces, the ledger and the events.

**What it never sees.** Nothing is hidden from it: it is an administrator's view
of the whole database, including encrypted credential rows. It cannot decrypt
them, because the key is in the environment rather than the database, but it is
the reason the dashboard is a profile you opt into rather than something that
starts by default.

---

## `redactor` - the redaction component

**What it is.** A small span model (`urchade/gliner_multi_pii-v1`, Apache-2.0,
289M parameters) behind a two-endpoint HTTP API, run from the same pinned
`python:3.12-slim` image the sandbox uses. Its wheels are installed into a cache
volume at first start and its model snapshot is fetched into another and
verified file by file against `redactor/models.sha256` before it is served; a
file that does not match refuses to start, and the health check says so. It
performs no hosted inference. Inference runs locally; first startup downloads
pinned wheels and the verified snapshot.

**What day0 uses it for.** Documentation pages at sync, HTTP and MCP provider
outcomes (effect, reason and id), and the ticket record the planner reads go
through the component. Other metadata, prompts and export use the synchronous
structural floor; export is not a complete personal-data scrub. Before any of
that, every boundary removes the exact values day0 itself stores for the owner:
the action that persists a page, an outcome, a grounding record or a run's
output first decrypts the owner's credential list in memory (bounded, never
persisted or logged) and removes each value literally, JSON-escaped and
URL-encoded, whether or not the component answered. The export is an action
(`exportActions:exportForAgent`) for the same reason: the synchronous trace
query cannot decrypt, so it is internal and the action removes the stored
values before answering. The model finds spans; what happens to each kind of span in each
place is data in `src/redaction/policy.ts`. Detected secret spans are removed (and, on a page, stored as encrypted
credentials with markers left behind). The policy keeps coworker names,
usernames, channels, ticket ids, dates, figures and audit lines as working
material. It removes detected phone numbers, personal addresses, government
and account identifiers and dates of birth; it keeps email addresses in stored
pages and removes them from provider outcomes. Detection still has misses and
false positives; these policy choices are not a guarantee of complete redaction. A deterministic guard keeps the model from
taking a placeholder, a stored marker or an identifier for a secret.

**When you need it.** Always in real mode. Without it a documentation sync
refuses to persist a page rather than store it in the clear, and a provider
outcome is recorded with `redaction: structural-only`, meaning only the exact
credential the transport sent and the structural grammar (connection-string
passwords, key blocks, JSON web tokens, header values, fixed-prefix provider
tokens) protected it.

**When you do not.** Mock mode, which reads nothing from outside the repository.

**What it never sees.** Anything but the text it is handed. It has no
credential, no database access and no host port; the backend reaches it at
`http://redactor:8000` on the compose network and nothing else needs to. It
keeps no log of what it was sent.

**The GPU.** `pnpm redactor:up` reserves the GPU the way `pnpm model:up` does
and installs the CUDA build of its wheels; `pnpm convex:up --profile redactor`
uses the CPU configuration by default. The reviewed CPU installation was Linux
x86-64 with Python 3.12. Its 37 pinned wheels total about 251 MB, and the five
verified snapshot files total 1.16 GB. CUDA download size was not measured in
this review. Through the HTTP client the backend uses, over the compose bridge
on a laptop CPU, the 77-case corpus took a median 423 ms and p95 860 ms per
call, from 328 ms for a short outcome to 1.30 s for a 1,216-character page;
measured through `docker exec` in review it was 838 ms median and p95
1,238 ms. Neither is the in-process figure the research report quotes. Calls
have a 10-second deadline; a timeout
fails documentation sync closed and marks provider evidence as limited redaction.
The dashboard displays that limitation. Exact matching covers the credential
supplied by the transport and every active credential stored for the owner;
it does not cover a secret day0 never stored.

---

## The other two

`--profile model` runs a bundled model server for the account-free path, and
`--profile sandbox` runs the local sandbox that verifies an authored skill
before it becomes callable. Both are described where they are set up, in the
repository README; neither is a way for day0 to reach one of your systems, which
is what the components above are for.
