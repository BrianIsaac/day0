# Contributing to Day0

Day0 is a small project with a large README. Most of what a contributor needs is already there; this file is the part that is about working on the code rather than running it.

## Set up a working copy

You need Node 22 or newer, pnpm 9 or newer, bash (the 3.2 macOS ships is enough), and Docker with the Compose v2 plugin, its daemon running and reachable by your user, for anything that touches the backend, the model service or the sandbox. `./setup.sh --dry-run` checks all of them, the daemon included, installs nothing and writes nothing.

```bash
git clone https://github.com/BrianIsaac/day0.git
cd day0
pnpm install --frozen-lockfile
./setup.sh                  # real mode; --route featherless|key|endpoint|local says where the model runs
pnpm dev
```

The clone can sit in a directory of any name. The setup names the Compose project after the directory, lower-cased and with anything Compose refuses turned into `-`, and a clone called `day0` gets a short suffix from its path, because `day0` is the name the maintainers' own stacks hold; the name is written to `.env.local`, so every later run agrees. After you move a checkout, `./setup.sh --adopt` re-adopts its installation, containers recreated and volumes kept.

`./setup.sh --route featherless` and `./setup.sh --route local` are the two local ways to run it, Local, cloud model and Local, local model, both real mode. `pnpm setup:local --route local|key` is the same setup in mock mode, the seeded office the evaluation harness and the hosted demo run on, which is what to set up for the harness and the mock-office tests. What each does, step by step, is in the README under [Local dev](README.md#local-dev). `pnpm check:setup` reports which of them the machine you are on is set up for.

The whole loop needs a model. It does not have to be a hosted one: `OPENAI_BASE_URL` points the model layer at any OpenAI-compatible endpoint, including the bundled local one, and `pnpm probe:model` tells you whether an endpoint can drive the loop before you wire it in.

## Commands

Every `pnpm` script, in the order a contributor meets them. The ones marked real mode act on the systems your documentation names; the rest touch only this machine.

| Command | What it does |
|---|---|
| `./setup.sh` | Real mode, one command: checks the prerequisites and runs `pnpm setup:local --mode real`; `stop`, `resume`, `clear` and `--adopt` manage the installation |
| `pnpm setup:local` | The same setup in mock mode, the seeded office the evaluation harness and the hosted demo run on |
| `pnpm dev` | The app under `next dev`, with the unlock URL printed first |
| `pnpm start` | `next start` on 3000 after a `pnpm build`; the hosted build's server, not the local way to run it |
| `pnpm dev:no-auth-key` | Writes the no-auth keys, the credential key and the Notion component's token into `.env.local` once |
| `pnpm check:setup` | Reports each setup, fails only on what is broken; `--report` prints the support bundle as JSON |
| `pnpm sync:env` | Pushes the deployment's env from `.env.local` |
| `pnpm convex:up`, `convex:down`, `convex:restart` | The self-hosted backend and any `--profile` components; `convex:down` keeps the data volume |
| `pnpm convex:admin-key` | Prints a fresh admin key from the backend container |
| `pnpm convex:dev` | The Convex CLI's own dev loop, for the Convex cloud route |
| `pnpm model:up`, `model:down`, `model:pull <id>` | The bundled model service, on the GPU where there is one, and its weights |
| `pnpm sandbox:up`, `sandbox:down` | The networkless skill sandbox |
| `pnpm redactor:up`, `redactor:down` | The span model that redacts documentation and the ledger |
| `pnpm redaction:record` | Records the span model's answers over the labelled corpus for the tests; it needs a redactor address this machine reaches, and says how to find one |
| `pnpm probe:model` | Whether an OpenAI-compatible endpoint can drive the loop |
| `pnpm probe:mcp <docSourceId>` | Real mode: lists a linked MCP documentation source's tools, from the backend |
| `pnpm probe:docs-source <docSourceId>` | Real mode: syncs one documentation source and prints its page and redaction counts |
| `pnpm probe:surface <surfaceId>` | Real mode: probes one surface card and prints the verdict |
| `pnpm demo:bed <subcommand>` | A restorable demonstration bed: snapshot, restore, up, preflight, offline-rung, down |
| `pnpm eval:comparison`, `eval:revocation`, `eval:gate` | The evaluation, below |
| `pnpm metrics:recompute <export>` | Recomputes an owner's supervision figures from a snapshot export |
| `pnpm lint`, `typecheck`, `test`, `build` | The gate, below |

The company bed's tools are maintainers' tooling rather than product commands, so they have no `pnpm` script and are run by their paths: `pnpm exec tsx scripts/bed/company.ts <verb>` (the synthetic company bed: its pages, its check and its seed), `pnpm exec tsx scripts/bed/record-spans.ts` (the span model's answers over the bed's pages) and `pnpm exec tsx scripts/bed/rehearse.ts` (the rehearsal).

`PLAYWRIGHT_ALLOWED_ORIGINS` in `.env.local` is the list of origins the browser component (`--profile browser`) may open, separated by `;`; the default is the demo tile and the app on this host.

## The gate

Every commit passes four commands, in this order, and the CI workflow in `.github/workflows/gate.yml` runs the same four on every push and pull request:

```bash
pnpm lint && pnpm typecheck && pnpm test
NEXT_PUBLIC_DEV_NO_AUTH= pnpm build
```

Run the first three before every commit, including a documentation-only one; a Markdown change cannot break them, but the habit is what keeps the tree green. Run the build before you open a pull request. The build refuses while `NEXT_PUBLIC_DEV_NO_AUTH=true` is in the environment, by design, so clear it as shown. Without a `.env.local` the build wants the three public placeholders the workflow sets: `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; the workflow's own values work.

`pnpm test` runs two Vitest projects: `convex`, under `edge-runtime`, for everything in `tests/convex/`, and `node` for the rest. It takes a few minutes. `pnpm test -- tests/convex/work.test.ts` runs one file.

## Tests mirror the tree

A test lives at the path of the module it covers, with `tests/` in front:

| Code | Test |
|---|---|
| `convex/work.ts` | `tests/convex/work.test.ts` |
| `src/work/evaluate.ts` | `tests/src/work/evaluate.test.ts` |
| `app/agent/[agentId]/page.tsx` | `tests/app/agent/...` |
| `scripts/check-setup.ts` | `tests/scripts/check-setup.test.ts` |

A change to a module comes with a change to its mirror. Convex functions are tested with `convex-test` against the real schema; the fakes they share live under `tests/convex/fakes/`, and every fixture more than one test reads lives under `tests/fixtures/`, whichever project reads it. A test that reproduces a defect before the fix is the preferred shape for a bug fix, and a seam test under `tests/app/` or `tests/src/` is the preferred shape for anything the dashboard shows.

Two conventions the existing tests follow and new ones should too:

- Nothing in `tests/` calls a model, a provider or the network. Model calls are replaced by recorded shapes and fakes; provider transports by in-process doubles, and on a live bed by the services under `fake-slack/` and `looker-tile/`.
- A test that schedules work through Convex drains the scheduler explicitly, with `convex-test`'s scheduled-function helpers or fake timers, rather than sleeping.

## Style

- TypeScript strict everywhere. No `any` that a type could replace.
- British English in prose and user-facing copy; US English in technical strings, which is what the SDKs use.
- No emojis in code or copy.
- Comments explain a non-obvious invariant or a workaround. They do not restate the code.
- Tailwind v4 through the single `app/globals.css`. Server-only secrets stay in `process.env`; the client sees `NEXT_PUBLIC_*` only.
- `eslint.config.mjs` is the linter's whole configuration. A disable comment is rare and carries its reason on the same line.

## Commits

Conventional commits, one change per commit:

```
type(scope): what the change does, in lower case, without a full stop
```

Types in use: `feat`, `fix`, `docs`, `test`, `chore`, `build`, `ci`, `refactor`, `perf`, `evidence`. The scope is the module or area (`work`, `charter`, `skills`, `surfaces`, `dashboard`, `evaluation`, `readme`, `setup`). The subject says what the change does, not what you did to make it. The body, when there is one, says why. No attribution trailers.

`evidence(evaluation)` is reserved for commits that add a new results directory under `evaluation/results/` and nothing else.

## Pull requests

Open the pull request against `main` from a branch. The template asks for what changed, why, how it was verified, and which of the documentation surfaces it touches. A pull request that changes behaviour a reader can see updates the README section that describes it, and the Chinese half of the same section, in the same change.

Two parts of the tree are edited with particular care:

- **`README.md`** is the deployment instruction a third party follows. A change to a command or a variable in it has been run, from a clean clone, before it is committed.
- **`evaluation/`** is the reproducible evidence. See the next section.

## The evaluation, and what is frozen

The controlled comparison and the revocation trials are described, with their method and their limits, in [`evaluation/README.md`](evaluation/README.md). Running them needs a self-hosted backend in mock mode, the local sandbox and a model:

```bash
pnpm eval:comparison         # 15 tasks, two arms, three runs each
pnpm eval:revocation         # a grant revoked while an action is queued
pnpm eval:gate               # the exact-action gate matrix, no model
```

Each run writes a new timestamped directory under `evaluation/results/`. The directories that are already there are **frozen evidence**: they are the files `evaluation/README.md` and the README quote, the cited beds carry a `SHA256SUMS` beside their evidence JSON (named `semifinal.json` in the directories written before 27 September 2026, `comparison.json` since), and none of them is edited, re-graded in place or deleted. A re-grade with `--regrade` writes a fresh directory and leaves the source alone. Earlier directories that no claim uses any more are kept as audit history rather than removed.

Three fixture files are frozen in the same sense, because changing them changes what the comparison measures: `evaluation/tasks/comparison.json`, `evaluation/onboarding/day0.json` and the graders in `evaluation/graders.ts`. A change to any of them is a new evaluation, not a continuation of an old one, and the harness refuses to resume an existing run across such a change. If you change them, say so in the commit and run the beds again.

## Security and disclosures

A suspected vulnerability goes through [`SECURITY.md`](SECURITY.md), not a public issue. The project's third-party dependencies, the boundary between simulated and real data, and the use of AI-assisted development are stated in the README under [Disclosures](README.md#disclosures); a change that adds a dependency or moves that boundary updates the statement.

## Licence

Day0 is licensed under Apache-2.0. By contributing you agree that your contribution is licensed under the same terms, as set out in [LICENSE](LICENSE).
