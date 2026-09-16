# Contributing to Day0

Day0 is a small project with a large README. Most of what a contributor needs is already there; this file is the part that is about working on the code rather than running it.

## Set up a working copy

You need Node 22 or newer, pnpm 9 or newer, and Docker with Compose v2 for anything that touches the backend, the model service or the sandbox.

```bash
git clone https://github.com/BrianIsaac/day0.git
cd day0
pnpm install --frozen-lockfile
pnpm setup:local            # the local stack, or follow one of the routes in the README
pnpm dev
```

`pnpm setup:local --route local|key` is the account-free and OpenAI-key routes in one command, and `./setup.sh --route featherless|local` is real mode. What each does, step by step, is in the README under [Local dev](README.md#local-dev). `pnpm check:setup` reports which of them the machine you are on is set up for.

The whole loop needs a model. It does not have to be a hosted one: `OPENAI_BASE_URL` points the model layer at any OpenAI-compatible endpoint, including the bundled local one, and `pnpm probe:model` tells you whether an endpoint can drive the loop before you wire it in.

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

A change to a module comes with a change to its mirror. Convex functions are tested with `convex-test` against the real schema; the fakes and fixtures they share live under `tests/convex/fakes/` and `tests/convex/fixtures/`. A test that reproduces a defect before the fix is the preferred shape for a bug fix, and a seam test under `tests/app/` or `tests/src/` is the preferred shape for anything the dashboard shows.

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
pnpm eval:semifinal          # 15 tasks, two arms, three runs each
pnpm eval:revocation         # a grant revoked while an action is queued
pnpm eval:gate               # the exact-action gate matrix, no model
```

Each run writes a new timestamped directory under `evaluation/results/`. The directories that are already there are **frozen evidence**: they are the files the submission quotes, the cited beds carry a `SHA256SUMS` beside their `semifinal.json`, and none of them is edited, re-graded in place or deleted. A re-grade with `--regrade` writes a fresh directory and leaves the source alone. Earlier directories that no claim uses any more are kept as audit history rather than removed.

Three fixture files are frozen in the same sense, because changing them changes what the comparison measures: `evaluation/tasks/semifinal.json`, `evaluation/onboarding/day0.json` and the graders in `evaluation/graders.ts`. A change to any of them is a new evaluation, not a continuation of an old one, and the harness refuses to resume an existing run across such a change. If you change them, say so in the commit and run the beds again.

## Security and disclosures

A suspected vulnerability goes through [`SECURITY.md`](SECURITY.md), not a public issue. The project's third-party dependencies, the boundary between simulated and real data, and the use of AI-assisted development are stated in the README under [Disclosures](README.md#disclosures); a change that adds a dependency or moves that boundary updates the statement.

## Licence

Day0 is licensed under Apache-2.0. By contributing you agree that your contribution is licensed under the same terms, as set out in [LICENSE](LICENSE).
