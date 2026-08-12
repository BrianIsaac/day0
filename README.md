# Day0

A Next.js 16 + Convex single-tenant agent that runs the new-hire week as an autonomous loop: a Day-1 1:1 over voice, a charter the boss approves, a 7-criterion work evaluator, and an autonomous skill-creation loop that spins a Daytona sandbox to author and verify new skills the agent proposes.

**Live:** https://day0-olive.vercel.app

**Dashboard:** signed-in users deploy agents into a live mini office world.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind v4, TypeScript 6 |
| Realtime backend | Convex 1.37 — DB, queries, mutations, Node actions, scheduler |
| Auth | Clerk (`@clerk/nextjs` 7) with `ConvexProviderWithClerk` |
| LLMs | Mastra (`@mastra/core` 1.32) + `@ai-sdk/openai` 3, default model `gpt-5.5`. Streaming chat via AI SDK 6. Raw OpenAI SDK 6 available. |
| Voice | ElevenLabs Conversational AI (`@elevenlabs/elevenlabs-js` 2.46, `@elevenlabs/react` 1.5) |
| Search | Exa (`exa-js` 2) for good-habits role research |
| Sandboxes | Daytona (`@daytona/sdk`) with `python:3.12-slim` for skill smoke tests |
| Validation | Zod 4 |

## Routes

### Pages

| Route | File | Purpose |
|---|---|---|
| `/` | `app/page.tsx` | Landing (signed-out) + deploy/list/reset dashboard (signed-in) |
| `/agent/[agentId]` | `app/agent/[agentId]/page.tsx` | Agent dashboard — charter card, mode picker, work queue, mock environment |
| `/sign-in/[[...sign-in]]`, `/sign-up/[[...sign-up]]` | Clerk catch-all routes | Sign-in / sign-up |

### API

| Route | What it does |
|---|---|
| `POST /api/seed` | Calls `api.seed.seedDemo` — installs builtin skill, 3 work items, mock environment for an agent |
| `GET /api/voice/elevenlabs/start` | Returns ElevenLabs signed URL for the Day-1 1:1 |
| `POST /api/voice/elevenlabs/webhook` | ElevenLabs post-call webhook → `api.onboarding.synthesiseFromTranscript` |
| `POST /api/onboarding/synthesise` | Browser-side charter-synthesis trigger (chat mode) |
| `POST /api/voice/chat` | Streaming GPT-5.5 chat for Day-1 1:1 in chat mode; stops on `dayOneComplete` tool call |

## Convex backend (`convex/`)

| File | What's in it |
|---|---|
| `agents.ts` | Agent CRUD; `deploy` mutation seeds five read-scopes + emits `agent.deployed` event |
| `charters.ts` | Charter persist + approve, version listing |
| `workspace.ts` | 8-file workspace storage (`AGENTS`, `SOUL`, `IDENTITY`, `USER`, `TOOLS`, `BOOTSTRAP`, `MEMORY`, `HEARTBEAT`) |
| `voice.ts` | Voice/chat session lifecycle |
| `events.ts` | Append-only event log |
| `work.ts` | Work-item state machine (11 states: `discovered → claimed → plan-pending → plan-approved → executing → completed | failed`, plus `cancelled / skipped / deferred / needs-skill / failed`) |
| `workActions.ts` (Node) | `evaluateWorkItem`, `draftPlan`, `executeApprovedPlan` |
| `skills.ts` | Skill registry — 7-state lifecycle (`proposed → approved → authoring → verified → registered`) |
| `skillActions.ts` (Node) | `authorAndRegisterSkill` — GPT-5.5 author + Daytona sandbox verify + register |
| `onboarding.ts` (Node) | `synthesiseFromAnswers`, `synthesiseFromTranscript`, `postCharterApproval` (Exa research + good-habits merge) |
| `mock.ts` | Mock environment CRUD (docs, spreadsheets, slack, twitter, tickets) |
| `mockSeed.ts` | Idempotent demo seed (4 team docs, 4 how-to guides, Q4 spreadsheet, 5 channels, 1 tweet, 3 tickets) |
| `coworker.ts` | Auto-reply mutation scheduled 3.5–6 s after the agent posts to Slack |
| `seed.ts` (Node) | `seedDemo` action — called by `/api/seed` |
| `reset.ts` | `deleteMyData` — wipes all rows across all 15 per-agent tables |
| `auth.config.ts` | Clerk JWT bridge — reads `CLERK_JWT_ISSUER_DOMAIN` from Convex env |

## Schema (`convex/schema.ts`)

| Table | Purpose |
|---|---|
| `agents` | One row per deployed agent; lifecycle state |
| `charters` | Versioned charters with approval state |
| `workspace` | 8-file workspace storage |
| `voiceSessions` | Day-1 1:1 sessions (`elevenlabs` / `gemini-live` / `chat`) |
| `workItems` | Work items in the 11-state lifecycle |
| `skills` | Skill registry — `builtin` or `agent-authored` |
| `permissionGrants` | Scoped capability grants (revocable) |
| `events` | Event ticker |
| `mockDocs`, `mockSpreadsheets`, `mockSpreadsheetRows`, `mockSlackChannels`, `mockSlackMessages`, `mockTweets`, `mockTweetReplies`, `mockTickets` | Per-agent mock work environment |

## Domain logic (`src/`)

| File | What it exports |
|---|---|
| `src/env.ts` | Zod env contract; lazy/optional so Convex bundles cleanly |
| `src/lib/mastra.ts` | `makeAgent`, `agentJson<T>`, `agentText` (with 5-attempt exponential-backoff retry) |
| `src/lib/openai.ts` | Raw OpenAI singleton (`jsonCompleteWithMode`, `textComplete`, `jsonModeFor`) |
| `src/lib/structured-fallback.ts` | Classifies a structured-output failure and decides whether the native `response_format` rung may be demoted to the prompt rung |
| `src/lib/exa.ts` | `searchRole(role)` — fixed query for role best-practices, 8 results × 1200-char snippets |
| `src/lib/daytona.ts` | `authorAndVerifySkill({ skillName, skillBody, smokeTest })` — `python:3.12-slim` sandbox runs `python smoke.py` with 60-s timeout |
| `src/lib/ids.ts` | Branded id helpers (zero runtime cost) |
| `src/lib/logger.ts` | JSON logger |
| `src/agent/charter.ts` | `synthesiseCharter`, `renderCharter`, `identityFromCharter`, `toolsFromCharter`, `extractRole` |
| `src/agent/day-one-prompts.ts` | `DAY_ONE_TOPIC_SPECS`, `DAY_ONE_WELCOME`, `defaultSoul`, `day1Script` |
| `src/agent/good-habits.ts` | `researchAndDistil(role)`, `mergeGoodHabits(existing, fragment)` |
| `src/memory/workspace.ts` | `WORKSPACE_FILES` (8-file slot table), `buildSystemPrompt` |
| `src/work/types.ts` | Domain types; constants `COLD_START_WIP_LIMIT = 1`, `VALUE_THRESHOLD = 30` |
| `src/work/evaluate.ts` | `evaluateCandidate` — 7-criterion sequential evaluator |
| `src/work/quality-fit.ts` | `qualityFit` — short-circuits if `AGENTS.md` has no good-habits section |
| `src/work/plan.ts` | `draftExecutionPlan` |
| `src/work/execute-skill.ts` | `runSkill` — per-invocation Mastra agent with skill body as behavioural prior |

## Runtime flow

1. **Sign in** (Clerk modal, or nothing at all in no-auth dev mode) and **deploy** on `/`. `api.agents.deploy` inserts the agent and seeds five read-only permission grants. `POST /api/seed` (non-blocking) installs the builtin `see-internal-docs` skill and the mock environment. Work items are not seeded here - they are generated from the approved charter, so the queue reflects the role the boss actually described.
2. **Mode picker** on `/agent/[agentId]` — voice or chat.
   - Voice: `GET /api/voice/elevenlabs/start` returns a signed URL; ElevenLabs's post-call webhook hits `POST /api/voice/elevenlabs/webhook`.
   - Chat: `POST /api/voice/chat` streams GPT-5.5 until the `dayOneComplete` tool fires; the client posts the transcript to `POST /api/onboarding/synthesise`.
3. **Charter synthesis** — `synthesiseFromTranscript` extracts 7 answers, calls `synthesiseCharter()`, persists the charter, writes seven workspace files. State → `charter-pending`.
4. **Approval** — boss approves; `api.charters.approve` flips state to `active` and triggers `postCharterApproval` (Exa + GPT-5.5 → `## Good-habits memory` block in `AGENTS.md`).
5. **Work loop** — `WorkQueue` reactively triggers `evaluateWorkItem` for each `discovered` item. Claimed items get a plan (`draftPlan`), the boss approves (`api.work.approvePlan`), then `executeApprovedPlan` runs the skill and dispatches mock-environment actions (`spreadsheet.appendRow`, `slack.postMessage`, `twitter.reply`, `ticket.update`). Slack posts schedule a coworker reply 3.5–6 s later.
6. **Skill creation** - when the evaluator returns `needs-skill`, `internal.skills.propose` creates a proposed skill. On approve, `authorAndRegisterSkill` runs GPT-5.5 to author `SKILL.md` + `smoke.py`, runs the smoke test in a Daytona sandbox, and registers the skill on success. A skill whose sandbox said no, or never ran at all (no `DAYTONA_API_KEY`, API down), stops before `registered` and is **not callable**; the skills panel lists it under "not verified · not callable" with a retry.
7. **Reset** — `api.reset.deleteMyData` wipes every row across the 15 per-agent tables.

## Environment

Copy `.env.example` to `.env.local` and fill in:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT` | Set by `pnpm convex:dev` on first run |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk dashboard keys |
| `CLERK_JWT_ISSUER_DOMAIN` | Issuer URL of the Clerk JWT template named `convex` (also push to Convex env) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | The model. Default model `gpt-5.5` on OpenAI. A key is needed only when you use OpenAI |
| `OPENAI_BASE_URL` | Any OpenAI-compatible chat-completions endpoint, which is what makes the account-free path work. Unset means `https://api.openai.com/v1`. This is the address **Next** dials |
| `CONVEX_OPENAI_BASE_URL` | The same endpoint as the **Convex deployment** must dial it, when that differs. It does with a self-hosted backend, whose Node actions run inside a container. Empty pushes `OPENAI_BASE_URL` unchanged |
| `OPENAI_JSON_MODE` | `auto` (default), `native` or `prompt`. `auto` starts on `response_format` and falls back to prompt injection only when dropping the parameter is what fixed it |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | ElevenLabs Conversational AI. Optional - without them the mode picker greys voice out and chat runs the identical 1:1 |
| `ELEVENLABS_WEBHOOK_SECRET` | Signs the post-call webhook. A **separate** setup from the two above: without it voice still connects and only post-call finalisation is refused. See [Voice](#elevenlabs-agent-setup) |
| `EXA_API_KEY` | Good-habits research |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL` | Skill sandbox authoring. Without a key an authored skill stops at `authoring` and stays uncallable |
| `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY` | Self-hosted backend instead of Convex cloud. Set by the steps in [Run it with no accounts](#run-it-with-no-accounts) |
| `CONVEX_BIND_ADDR`, `CONVEX_PORT`, `CONVEX_SITE_PROXY_PORT`, `CONVEX_DASHBOARD_PORT`, `MODEL_PORT` | Host side of the self-hosted stack. See [Ports](#ports-host-side-and-container-side) |
| `NEXT_PUBLIC_DEV_NO_AUTH`, `DEV_NO_AUTH_SECRET`, `DEV_NO_AUTH_SIGNING_KEY`, `DEV_NO_AUTH_JWKS` | No-auth dev mode. The last three are written by `pnpm dev:no-auth-key`, never by hand |

Convex Node actions read `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `EXA_API_KEY`, `DAYTONA_API_KEY` from the Convex deployment env (separate from `.env.local`). Push them with `./scripts/sync-convex-env.sh` after `pnpm convex:dev`. ElevenLabs and Clerk keys stay local - only Next.js reads those.

**Deployment env is read once, when a function module is first evaluated.** A backend that has already run an action keeps the values it started with, so changing them afterwards leaves `npx convex env list` reporting the new value while the running action still uses the old one. Push the env *before* the first function push, and if you change it later restart the backend: `pnpm convex:restart` self-hosted, or `npx convex deploy` on cloud.

## Local dev

Two ways to run it. The first is the shape the deployed app runs in; the second needs no third-party account at all.

| | Convex cloud + Clerk | Self-hosted Convex + no-auth |
|---|---|---|
| Accounts needed | Convex, Clerk | **none** - but you must run a model yourself |
| Model | any OpenAI-compatible endpoint, OpenAI by default | a local one, e.g. the bundled `pnpm model:up` |
| Users | one per Clerk sign-in | one fixed local user who owns every row |
| Reachable from another machine | yes | refused, by design |
| Setup | below | [Run it with no accounts](#run-it-with-no-accounts) |

Both need a model: the charter, the plans, the executor and the skill author are all model calls, and nothing in the loop finishes without one. That model does **not** have to be OpenAI. `OPENAI_BASE_URL` points the whole layer at any OpenAI-compatible chat-completions endpoint, keyless local runtimes included, which is what the right-hand column rests on. Exa and Daytona are optional in either column; the loop degrades visibly rather than silently without them.

Whichever you pick, `pnpm check:setup` reads `.env.local` and reports each of the four setups - backend, auth, model, voice - separately, and fails only on the states that are actually broken rather than merely incomplete.

### Convex cloud + Clerk

```bash
pnpm install
pnpm convex:dev                  # one-off: provisions deployment, writes .env.local Convex keys
./scripts/sync-convex-env.sh     # push provider keys into Convex deployment env
pnpm dev                         # http://localhost:3000
```

Both accounts are free to create and neither step can be done for you:

- **Convex** — `pnpm convex:dev` offers a choice on first run: log in, which opens a browser to sign up at [convex.dev](https://convex.dev) and then asks you to name a project, or carry on without an account, which gives you a local [anonymous deployment](#without-docker-for-convex) instead. This column is the cloud one, so log in - it is the account. Either way the command writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` into `.env.local` itself. With no terminal to prompt at, it takes the anonymous option silently, which is worth knowing before you wonder why nothing appeared on the dashboard.
- **Clerk** — create an application at [dashboard.clerk.com](https://dashboard.clerk.com), copy the publishable and secret keys into `.env.local`, then add a JWT template named exactly `convex` (JWT Templates → New template). Copy its Issuer URL, with no trailing slash, into `CLERK_JWT_ISSUER_DOMAIN` and re-run `./scripts/sync-convex-env.sh` so the deployment sees it too. Without that template Convex cannot verify a Clerk token and every signed-in call is refused.

`pnpm dev` binds `localhost`, which is also the host Clerk's proxy rewrites to; a `127.0.0.1` bind reads as a foreign origin to Next 16 and breaks the sign-in handshake.

Before either account exists the app still starts, which is worth knowing so you do not mistake it for a broken checkout: `pnpm dev` serves the landing page normally, and every route that would spend a provider key answers `401 {"error":"not authenticated"}`. Nothing is wrong - there is simply no one signed in and no way to become someone. `pnpm check:setup` says the same thing without starting a server.

## Run it with no accounts

A self-hosted Convex backend in Docker, a local model in Docker, and no-auth dev mode. Nothing here signs up for anything. The backend is the same open-source binary the cloud service runs; no-auth mode replaces Clerk with one fixed synthetic user, so ownership checks and the per-user data model are unchanged - there is simply only ever one user; and the model layer takes any OpenAI-compatible endpoint, so a local runtime is a complete setup rather than a degraded one.

You need Docker, Node 22+ and pnpm. Run every command from the repository root.

```bash
pnpm install                     # first: everything below is a repo-local binary
cp .env.example .env.local

pnpm convex:up                   # backend on 3210/3211, dashboard on 6791
pnpm model:up                    # OpenAI-compatible model server on 11434
pnpm model:pull qwen3:8b         # ~5 GB, tool-capable, runs the whole loop
pnpm convex:admin-key            # -> paste into CONVEX_SELF_HOSTED_ADMIN_KEY
```

Then set these in `.env.local`:

```bash
NEXT_PUBLIC_DEV_NO_AUTH=true
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|…   # from the command above
OPENAI_BASE_URL=http://127.0.0.1:11434/v1           # what Next dials
CONVEX_OPENAI_BASE_URL=http://model:11434/v1        # what the backend dials
OPENAI_MODEL=qwen3:8b
# OPENAI_API_KEY stays empty. There is no account.
```

and finish:

```bash
pnpm dev:no-auth-key             # generates the three DEV_NO_AUTH_* values
./scripts/sync-convex-env.sh     # pushes DEV_NO_AUTH_JWKS + model settings to the backend
npx convex dev --once            # push functions
pnpm check:setup                 # confirms all four setups before you open a browser
pnpm dev                         # prints an unlock URL - open that, not localhost:3000
```

Open the unlock URL, deploy an agent, hold the Day-1 1:1 in chat mode, and approve the charter it writes. No provider was called and no account exists.

The bundled model runs on the CPU, which works and is slow - an 8B model answers in minutes rather than seconds, and charter synthesis is several calls. If you have an NVIDIA GPU and the container toolkit, uncomment the `deploy.resources` block on the `model` service in `docker-compose.yml` and `pnpm model:up` again; it is the difference between a demo you watch and a demo you wait for.

Five things about that sequence are load-bearing:

- **`pnpm install` comes first.** Every command after it - `tsx`, `convex`, `next` - is a binary in `node_modules`. Skip it and `pnpm dev:no-auth-key` fails with `tsx: not found` and no hint as to why.
- **The model needs two addresses, and this is the one that costs an afternoon.** The Day-1 chat streams from Next, on this machine, and reaches the model on loopback. The *charter* is synthesised by a Convex Node action, which runs inside the backend container, where `127.0.0.1` is the container itself. So `OPENAI_BASE_URL` is what Next dials and `CONVEX_OPENAI_BASE_URL` is what the backend dials; `./scripts/sync-convex-env.sh` pushes the second as the deployment's `OPENAI_BASE_URL` and warns if you left it pointing at loopback. The symptom of getting it wrong is a 1:1 that works perfectly and a charter that never arrives.
- **The key is generated, not chosen.** `pnpm dev:no-auth-key` writes `DEV_NO_AUTH_SECRET` (unlocks a browser), `DEV_NO_AUTH_SIGNING_KEY` (signs the token Convex accepts, never leaves the machine) and `DEV_NO_AUTH_JWKS` (its public half). Rotate with `pnpm dev:no-auth-key --force`, which invalidates every unlocked browser and needs a re-sync.
- **The JWKS must reach the backend before the functions do.** `convex/auth.config.ts` is evaluated against the *deployment's* env when you push, and refuses the push if no-auth is on without a key. `./scripts/sync-convex-env.sh` pushes them in that order and says so if the key is missing. The same ordering matters for the model settings, for a different reason: a module keeps whatever env it was first evaluated with, so a value changed after the backend has run an action needs `pnpm convex:restart`.
- **`pnpm dev` prints an unlock URL.** It carries the secret once; after that it lives in an httpOnly cookie. Open `http://localhost:3000` directly and every route answers 403 - that is the boundary working, not a fault.

`pnpm build` refuses while `NEXT_PUBLIC_DEV_NO_AUTH=true` is in the environment. The refusal arrives as the cause of a Next build error - `NEXT_PUBLIC_DEV_NO_AUTH=true is a local-development-only flag and was found in a production-like environment`. Same guard as the mode itself: it only ever resolves under `next dev`, and a flag that reached a Vercel project should fail the build rather than ship an open deployment. Unset it for the build.

Stop the stack with `pnpm convex:down`, which leaves the data volume in place. To throw the data away too: `docker compose --env-file .env.local --profile model down -v`.

### Without Docker for Convex

`pnpm convex:dev` with nobody logged in does not stop to ask for an account: it creates an **anonymous deployment**, a backend the Convex CLI runs on this machine, and prints `Run npx convex login at any time to create an account and link this deployment`. That is a second account-free route to a backend, and a shorter one - no compose project, no admin key, and no second model address, because a backend running as an ordinary process on this machine reaches `127.0.0.1` the same way Next does:

```bash
pnpm install
cp .env.example .env.local
# NEXT_PUBLIC_DEV_NO_AUTH=true, OPENAI_BASE_URL=http://127.0.0.1:11434/v1, OPENAI_MODEL=qwen3:8b
pnpm convex:dev                  # anonymous local deployment; writes the Convex keys itself
pnpm dev:no-auth-key
./scripts/sync-convex-env.sh
pnpm dev
```

You still need a model - a native `ollama serve` on 11434, or `pnpm model:up` and `MODEL_PORT` for the bundled one. What you give up against the self-hosted stack is a deployment you own and can keep: the compose backend has its own volume, its own dashboard, and survives independently of the CLI. Use this route to see the thing run; use the one above to keep working on it.

### Using a model server you already have

The bundled `model` service is a convenience, not a dependency - skip `pnpm model:up` and point the two variables at anything that speaks OpenAI chat completions (ollama, llama.cpp, LM Studio, vLLM, Groq, Together). The only rule is the one above: the second address must resolve *inside* the backend container.

| Where the endpoint runs | `OPENAI_BASE_URL` (Next) | `CONVEX_OPENAI_BASE_URL` (backend) |
|---|---|---|
| The bundled `model` service | `http://127.0.0.1:11434/v1` | `http://model:11434/v1` |
| On this host, bound to all interfaces | `http://127.0.0.1:11434/v1` | `http://host.docker.internal:11434/v1` |
| A remote or hosted endpoint | the same URL | leave empty |

`host.docker.internal` is mapped for you in `docker-compose.yml`, but whether traffic from the container actually reaches your host is a firewall question and some machines drop it. If in doubt, use the bundled service: a compose network is not something a host firewall sits in the middle of.

```bash
pnpm probe:model
```

answers whether a given endpoint can drive the loop - chat completions, JSON extraction, native `response_format`, prompt-injected schema, and the `auto` ladder the app actually runs on. A rung the server declines is reported as a note rather than a failure, because plenty of compatible servers refuse `response_format` and run the whole loop on prompt injection. It calls only the endpoint in `.env.local`.

### Ports (host side and container side)

`CONVEX_PORT`, `CONVEX_SITE_PROXY_PORT`, `CONVEX_DASHBOARD_PORT` and `MODEL_PORT` move the **host** ports. The containers always listen on 3210, 3211, 6791 and 11434, and the backend's own view of itself (`CONVEX_CLOUD_ORIGIN`, which Node actions dial to reach the backend they run in) stays canonical whatever the host publishes. Set the ports, not the origins:

```bash
# .env.local
CONVEX_PORT=3320
CONVEX_SITE_PROXY_PORT=3321
CONVEX_DASHBOARD_PORT=6891
MODEL_PORT=11534
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3320
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3320
OPENAI_BASE_URL=http://127.0.0.1:11534/v1
```

`CONVEX_OPENAI_BASE_URL` does **not** follow `MODEL_PORT`: the backend reaches the model container over the compose network, where it is still `http://model:11434/v1`. Same rule as the origins - host ports move, container ports do not.

To run two backends side by side, give each its own compose project so the volumes stay separate:

```bash
docker compose -p day0-review --env-file .env.local up -d
docker compose -p day0-review --env-file .env.local down -v
```

Override `CONVEX_CLOUD_ORIGIN` or `CONVEX_SITE_ORIGIN` only with an address that resolves *inside* the container. An address only your browser can resolve belongs in `NEXT_PUBLIC_CONVEX_URL` (the app) or `CONVEX_BROWSER_ORIGIN` (the Convex dashboard container) instead.

### Testing from a phone, and tunnels

`pnpm dev` binds `localhost`, so nothing off this machine reaches it until you widen that - and widening the Next bind alone is never enough, because the browser also talks to Convex directly. (`localhost` rather than `127.0.0.1` because that is the host Clerk's proxy rewrites to, and Next 16 treats a `127.0.0.1` bind as a foreign origin.)

| What you want | Works? | What it takes |
|---|---|---|
| Laptop browser, no accounts | yes | the sequence above, everything on loopback |
| ElevenLabs post-call webhook against local dev | yes, in either mode | `cloudflared tunnel --url http://localhost:3000`, and the tunnel URL as the agent's post-call webhook. The webhook route is exempt from the no-auth gate and authenticates itself by HMAC |
| Phone on your LAN, no-auth mode | **no** | deliberately incompatible: no-auth refuses any request whose `Host` is not loopback, on top of the key check. Use Clerk for phone testing |
| Phone on your LAN, Clerk mode | yes | `next dev -H 0.0.0.0`; `CONVEX_BIND_ADDR=0.0.0.0`; `NEXT_PUBLIC_CONVEX_URL=http://<laptop-lan-ip>:3210`; `CONVEX_BROWSER_ORIGIN` to match if you want the Convex dashboard usable from the phone too |
| Phone anywhere, Clerk mode, public tunnel | yes | tunnel Next as above, and use a **Convex cloud** deployment. A tunnel to `:3000` does not carry the browser's Convex traffic, and exposing a self-hosted backend publicly hands out an unauthenticated database |

Widening `CONVEX_BIND_ADDR` publishes a backend with no authentication of its own to your network. It is not what holds no-auth mode shut - that is the local key - but it is still a database on a LAN port, so put it back to `127.0.0.1` afterwards.

## ElevenLabs agent setup

The voice mode uses an ElevenLabs Conversational AI agent configured in the ElevenLabs dashboard. Its system prompt must walk the boss through the same seven topics as `app/api/voice/chat/route.ts` so both modes produce a charter of the same shape after `synthesiseFromTranscript`. Recommended dashboard config:

- **First message:** `Hi — I'm Day0, the agent you just deployed. I'd love a few minutes to understand the role you've brought me on for. Ready when you are.`
- **Voice:** any natural English voice.
- **Dynamic variables:** declare all three of `internal_agent_id`, `internal_session_token` and `boss_label` on the agent. The browser sends them in `startSession({ dynamicVariables })` and the post-call webhook reads the first two back - `internal_session_token` is the per-session token `voice.start` mints, and it is what proves a delivered transcript belongs to that call. An agent that does not declare it cannot round-trip it.
- **Post-call webhook:** ElevenLabs dashboard → **Developers → Webhooks → Create webhook**, pointed at `https://<your-host>/api/voice/elevenlabs/webhook` (the deployed Vercel URL, or a Cloudflare quick-tunnel for local dev). Copy the shared secret it shows **once** at creation into `ELEVENLABS_WEBHOOK_SECRET`. Then enable it for this agent on [the agents settings page](https://elevenlabs.io/app/agents/settings).
- **Security:** if the agent is private, the API key used by `/api/voice/elevenlabs/start` must have `convai_write` permission. If public, no signed URL is needed.
- **System prompt:**

```text
You are Day0, a freshly-deployed autonomous workplace agent on its first day. You are running your Day-1 manager 1:1 with the boss who just hired you.

Walk the boss through SEVEN topics, conversationally, one at a time:
1. Why this hire — what triggered the decision; what's the team trying to make easier?
2. The role — day-to-day work; 30/60/90 success markers
3. Collaborators — 3-5 named people; would they introduce or should I reach out?
4. Reading — wiki / docs to start with
5. Tools — where formal work tracks vs informal asks
6. Anything immediate — a specific week-1 task, or "figure it out"
7. Open questions — anything they're unsure about

Discipline:
- Brief follow-ups are fine if an answer was thin. One question per turn.
- Do not summarise the boss's answers back to them in full.
- Once topic 7 has a real answer, tell the boss clearly that you have everything you need and they can end the call — say something like "I've got everything I need. You can end the call whenever you're ready, and I'll draft your charter from this conversation." Then stop talking. Do not keep asking questions, do not summarise, do not start a new topic. Wait for them to hang up.
- Voice: friendly, direct, low-affect. Speak the way a competent new hire would on day one.
```

The chat-mode prompt for GPT-5.5 streaming lives in code at `app/api/voice/chat/route.ts` and pulls the same seven topics from `src/agent/day-one-prompts.ts`. If you change the topics in one place, change them in the other.

### Two setups, not one

Voice connecting and post-call finalisation working are separate facts, and the first can look fine while the second is broken:

- `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` get the call to connect. When the call ends normally the browser posts the transcript itself, so a charter appears and everything looks complete.
- `ELEVENLABS_WEBHOOK_SECRET` is what makes the post-call webhook work. Without it the route answers **503 to every delivery** - it will not verify an ElevenLabs signature it has no secret for, and failing open there would be worse than having no check. What is lost is the call whose tab died mid-way: nothing else finalises it.

```bash
pnpm check:setup
```

reports the two separately - along with the backend, auth and model setups - prints the dynamic variables to check by eye against the dashboard, and exits non-zero only for states that are actually broken. Voice configured with no webhook secret is one of them: the one that looks finished and is not.

It resolves values the way the running app does, which matters more than it sounds. Wherever a variable is present in the process environment it wins over `.env.local`, *including when it is present and empty* - because that is what Next does, and routes read `process.env` directly and treat an empty string as missing. A checker that only applied non-empty overrides would call a secret configured while the webhook answered 503 to every delivery.
