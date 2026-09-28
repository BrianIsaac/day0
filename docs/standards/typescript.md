# day0 TypeScript standard

Status: done, 2026-09-26. Rules grounded in the tree at commit 7f59973; the reasoning and sources are in `docs/research/typescript-code-hygiene-2026-09-26.md`.

Read this before every task. Every rule is something a reviewer can check on a diff. Each rule has a one-line reason; where an example helps, a good/bad pair follows. `Follows:` and `Violates:` cite the tree so the rule is about this codebase, not a generic one. Where the gate does not enforce a rule yet, the rule says so: review enforces it until the lint does.

## 0. How to read this document

- MUST is a review blocker. SHOULD is a default a reviewer may accept a stated reason to break. The reason goes in the code or the commit, not the review thread.
- Cited lines are at 7f59973 and will drift. The rule stands when the line moves.
- A pane brief points at a section number. A review names the section it applies.
- CONTRIBUTING.md is the process document; this is the code document. Where they overlap they agree, and this one is more specific.

## 1. Module boundaries and imports

1.1 MUST use named exports, except where Next.js or Convex requires a default (`page.tsx`, `layout.tsx`, `route.ts`, `convex/schema.ts`, `convex/crons.ts`, `convex/auth.config.ts`). Reason: a default has no canonical name, so the same module gets three names across the tree. Follows: `src/` has no default export.

1.2 MUST mark type-only imports with `import type` or an inline `type` modifier. Reason: bundlers and the Convex bundler strip them safely, and `verbatimModuleSyntax` will require it.
```ts
import { decryptCredential, type DecryptCredential } from './credentials';   // src/surfaces/http.ts:4
import { ReactNode, useCallback } from 'react';                              // app/providers.tsx:6, violates
```

1.3 MUST NOT import a Convex implementation module (`convex/*.ts`) from `app/` or `src/`. Import only `convex/_generated/api` (`api`, `internal`), `convex/_generated/dataModel` (`Doc`, `Id`) and `convex/_generated/server` (the `*Ctx` types). Reason: a `src/` module that imports `convex/mock.ts` cannot be tested or type-checked without the backend's registration machinery, and it hides the boundary the deploy draws. Follows: `src/surfaces/http.ts:1-2`. Violates: `src/lib/dev-auth-server.ts:6`, `src/surfaces/mock.ts:4`, `app/metric-format.ts:1`. A type another layer needs moves to `src/` and `convex/` imports it from there.

1.4 MUST NOT import from `app/` anywhere outside `app/`. Reason: `app/` is the outermost layer. Follows: no `src/` or `convex/` module does.

1.5 MUST NOT import a `'use node'` Convex file from a file without the directive, and MUST NOT put a query or mutation in a `'use node'` file. Reason: Convex's runtime rule; the push fails or the function silently runs in the wrong runtime. Follows: `convex/docSyncActions.ts:1` holds actions only.

1.6 SHOULD use the `@/` and `@convex/` aliases in `app/` and `src/` and relative paths inside a directory. Tests use relative paths because the `convex` vitest project has no alias. Reason: one spelling per target makes grep reliable.

1.7 MUST keep `route.ts` to the HTTP verb handlers and segment config exports. Helpers live in `src/`. Reason: Next's generated route types reject any other export at build.

1.8 MUST read a non-`NEXT_PUBLIC_` variable only in server code, and SHOULD mark a module that does so with `import 'server-only'`. Reason: Next inlines only public variables into the client; the rest become empty strings and the bug is silent. Violates: no module in `app/` or `src/` uses `server-only`; `src/env.ts` reads `process.env` and is imported unguarded from `app/api/voice/elevenlabs/start/route.ts:3`.

## 2. Naming

2.1 MUST use `camelCase` for values and functions, `PascalCase` for types, interfaces, classes and components, `UPPER_SNAKE` for primitive configuration constants (timeouts, limits, names). A `const` object or validator keeps `camelCase`. Reason: the case tells a reader the kind before the type does. Follows: `src/surfaces/http.ts:29` `HTTP_TIMEOUT_MS`, `convex/work.ts:271` `workItemSeedFields`.

2.2 MUST treat abbreviations as words: `loadHttpUrl`, `agentId`, not `loadHTTPURL`. MUST NOT prefix or suffix with `_`, and MUST NOT prefix interfaces with `I`. Reason: information the type already carries does not belong in the name.

2.3 File names: `kebab-case.ts` in `src/`, `scripts/` and `tests/`; `camelCase.ts` in `convex/` because the file name becomes the function path (`api.workActions.x`); `PascalCase.tsx` for a component file in `app/`, `kebab-case` for everything else there. Reason: each directory has one convention and the tree already follows it. Violates: `app/agent/[agentId]/corrections-panel.tsx` exports a component; `tests/convex/work-loop.test.ts` mirrors `convex/workLoop.ts` under a different case.

2.4 SHOULD name by the problem domain (`workItem`, `charter`, `surface`), not the mechanism, and SHOULD spell British in identifiers you coin (`serialise`, `colour`) while keeping the SDK's spelling where an identifier mirrors one (`normalizeId`, `color` in a Linear payload). Reason: a grep for the domain word finds the code; a renamed SDK field breaks the call.

## 3. Types versus interfaces

3.1 MUST declare an object shape with `interface` and everything else (unions, intersections, mapped, conditional and function types, aliases of primitives) with `type`. Reason: the handbook, Google and Effective TypeScript all default to `interface` for objects, and the tree is 96 percent there already. Follows: `convex/orientationActions.ts:85`. Violates: `convex/orientationActions.ts:73` declares an object shape as a `type` alias in the same file.

3.2 MUST NOT declare two interfaces with the same name in one scope. Reason: they merge silently. This is the hazard behind the "use `type`" school and review catches it.

3.3 SHOULD model alternatives as a tagged union of interfaces with a literal discriminant, and SHOULD keep `null` at the edges of a type rather than on every field. Reason: control-flow narrowing works on a discriminant and not on a bag of optionals.

3.4 MUST NOT declare an `enum` or a `namespace`. Use a `const` tuple with `as const` and a derived union, or `v.union(v.literal(...))` in a validator. Reason: both are non-erasable syntax; TypeScript's `erasableSyntaxOnly` rejects them and the tree has none. Follows: `src/surfaces/types.ts:8`.

3.5 SHOULD use `class` only for `Error` subclasses and stateful adapters with a lifecycle; SHOULD NOT use parameter properties in new classes. Reason: parameter properties are the one remaining construct that keeps the tree from `erasableSyntaxOnly` (45 sites, for example `src/lib/mastra.ts:167`).

## 4. `unknown` over `any`

4.1 MUST NOT write `any`. Take `unknown` and narrow with `typeof`, `instanceof`, a type guard or a validator. Reason: `unknown` cannot be dereferenced until you prove its shape; `any` switches the checker off for everything it touches. Follows: `src/surfaces/types.ts:21` `isSurfacePath(value: unknown): value is SurfacePath`.

4.2 The one permitted `any` is a generic constraint (`(...args: any[]) => unknown`) or a third-party type hole, confined to a single line, with `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`. Follows: `src/lib/mastra.ts:479-480`, though its reason sits above rather than on the line (see 14.3).

4.3 MUST NOT declare `v.any()` for a payload the code then reads by field. Reason: the validator is the boundary; `v.any()` moves the boundary to whichever line first dereferences the value. Violates: `convex/work.ts:1752,1774,1789,1861,3011`, `convex/charters.ts:135`.

4.4 MUST catch as `unknown` (`catch (err)` under `useUnknownInCatchVariables`, which `strict` turns on) and narrow before reading `.message`. Reason: anything can be thrown. Violates: `src/lib/exa.ts:65` `(err as Error).message`.

## 5. Exhaustiveness

5.1 MUST make every branch over a union exhaustive by one of two means: a `never` assignment in the `default`, or a declared return type with no `default` so the compiler reports the missing case. MUST NOT close a `switch` over a union with a catch-all `default` that does work. Reason: a catch-all turns "you forgot a state" into runtime behaviour nobody wrote.
```ts
default: { const unknown: never = change; throw new Error(`unhandled ${String(unknown)}`); }  // src/agent/charter-amendment.ts:264-266
switch (row.state) { /* some states */ default: /* catch-all */ }                            // convex/workLoop.ts:250-276, violates
```
Follows also: `src/docs/readers/index.ts:18-27`, no `default`, return type forces every kind.

5.2 SHOULD use `satisfies` to check a literal against a type without widening it. Follows: `src/surfaces/http.ts:28`.

5.3 Gate: `@typescript-eslint/switch-exhaustiveness-check` is not on (it needs typed linting). Review checks this rule until it is.

## 6. Error handling and the never-swallow rule

6.1 MUST throw only `Error` or a subclass, with `new`. MUST reject promises with an `Error`. Reason: only `Error` carries a stack and a stable `.message`. Follows: `convex/surfaceActions.ts:157` `class Day0ProbeLimitation extends Error {}`.

6.2 MUST NOT swallow. Every `catch` and every `.catch` does one of: rethrow with context, return a typed failure the caller must handle, or log through `src/lib/logger.ts` and continue with a stated reason. An empty `catch` is allowed only for a "not this shape, try the next" probe and carries a comment saying so. Reason: a swallowed error is a bug with its evidence deleted.
```ts
} catch (err) { const reason = ...; log.warn('exa research skipped', { role, reason }); return { results: [], skipped: true, skipReason: reason }; }  // src/lib/exa.ts:64-67
postApproval({ ... }).catch(() => {});                                                   // app/agent/[agentId]/AgentDashboard.tsx:818, violates
```
Violates also: `app/page.tsx:414`. Allowed: `src/surfaces/mcp.ts:319-321`, empty catch with the reason.

6.3 MUST use `ConvexError` for any failure a client is meant to read. Reason: in production Convex strips every other exception's detail before it reaches the browser. The tree uses none yet; the first client-read failure introduces it.

6.4 MUST log through `src/lib/logger.ts`, never `console.*`, outside that module and the CLI scripts. Reason: one JSON line format that the function logs and the export can parse. Violates: `src/docs/system-discovery.ts:141`, `src/lib/mastra.ts:118`, `src/lib/model-call-telemetry.ts:174`, `convex/credentialCryptoActions.ts:58`.

6.5 SHOULD keep a `try` block to the one call that can throw. Reason: a wide `try` hides which line failed.

## 7. Async and promise discipline

7.1 MUST await, return or hand to `Promise.all` every promise. No fire-and-forget. Reason: a floating promise's rejection is unhandled and, in Convex, its write may not happen at all ("await all promises", Convex best practices).
```ts
const [roleLine, counts] = await Promise.all([...]);                 // convex/agents.ts:363-366
startSession({ agentId, mode: 'chat' }).then((started) => { ...    // app/agent/[agentId]/ChatRoom.tsx:168, violates
```

7.2 `void promise` is allowed only with a comment on the same statement saying why the result is discarded and where a rejection lands. Reason: `void` satisfies the lint, not the rejection. Follows: `app/agent/[agentId]/ChatRoom.tsx:209-215`.

7.3 MUST NOT pass an `async` function where a `void`-returning callback is expected (`onClick`, `forEach`, event handlers). Wrap it and handle the rejection. Violates: `app/agent/[agentId]/AgentDashboard.tsx:883` passes the `async` `onApprove` from line 807 as `onClick`.

7.4 In Convex: MUST schedule and `ctx.run*` only `internal.*` functions; SHOULD NOT chain sequential `ctx.runMutation` calls from an action when one mutation can do the work in one transaction; MUST let a browser trigger side effects through a mutation that records intent and schedules the action. Reason: each `ctx.run*` from an action is its own transaction, and a browser's fire-and-forget is the one the review found seeding proposals (P9-10). Violates: `convex/docSyncActions.ts:77-78` loops `ctx.runMutation` per page.

7.5 SHOULD run independent awaits in parallel with `Promise.all` and MUST keep dependent awaits sequential. Reason: latency and correctness respectively.

7.6 Gate: `no-floating-promises` and `no-misused-promises` need typed linting and are not on. Review enforces 7.1 to 7.3 until they are.

## 8. Immutability

8.1 MUST use `const`; `let` only for a value that is reassigned in the same function. Never `var`.

8.2 MUST mark properties that are never reassigned `readonly`, and SHOULD take array and object parameters as `readonly T[]` or `Readonly<T>` when the function does not mutate them. Reason: the signature then says what a comment would have said. Follows: `src/lib/mastra.ts:167`, `app/agent/[agentId]/corrections-panel.tsx:35`.

8.3 MUST NOT mutate a parameter or module-level state. A test seam that replaces a module-level client is the one exception and its setter is named `__setXForTest`. Violates: `src/lib/exa.ts:5` with writes at 9 and 73 is that seam, acceptable; `src/env.ts:132` deletes `process.env` keys at import time, which is not.

8.4 SHOULD build objects in one expression rather than by assignment after creation. Reason: the type is right from the first line.

## 9. Function size and single responsibility

9.1 A function does one thing at one level of abstraction. The reviewer's test: can you name it without "and", and does every line sit at the same altitude as its neighbours? Reason: the only sources with a rule agree on this and disagree on numbers.

9.2 Soft thresholds that trigger the question, not a refusal: an exported function over about 80 lines, a function with more than three parameters (take one object), a file over about 1,000 lines. Follows: `src/agent/charter-amendment.ts:127-131`. Violates: `convex/workActions.ts:1899-2211` (313 lines), `convex/surfaceActions.ts:1012-1306`, `src/surfaces/registry.ts:401-690`; `convex/work.ts` at 4,491 lines.

9.3 Convex functions are thin. The `query`, `mutation` and `action` wrappers validate, authorise and call a helper; the helper holds the logic and is what the unit test calls. Reason: Convex's own best practice and the only way `convex-test` stays fast.

## 10. Dependency direction

10.1 Layers, outermost first: `app/` depends on `src/` and on `convex/_generated` types. `src/` depends on `convex/_generated` types only. `convex/` is the composition root and may depend on `src/` (`convex/work.ts:1`, `convex/agents.ts:13`) and never on `app/`. `scripts/` may depend on `src/` (`scripts/check-setup.ts:38`). `tests/` mirrors whichever layer it tests. Reason: `src/` must run and be tested without a backend or a browser.

10.2 MUST NOT create an import cycle between modules. Reason: the initialisation order becomes load-order dependent.

10.3 MUST put a type two layers share in `src/`, not in `convex/`. Reason: see 1.3.

10.4 In Convex, MUST validate arguments on every public function and MUST call an ownership guard from `convex/ownership.ts` in every public function that touches a per-agent row. Reason: public functions are callable by anyone; the 24 Sep review (P9-4) found public evaluation functions any signed-in user can drive. MUST prefer `.withIndex` to `.filter` and MUST bound every read (`.take`, `.paginate`, an index) unless the table is known small; P9-1 records the unbounded `collect()` sweeps.

## 11. Test conventions

11.1 MUST mirror: `convex/work.ts` is tested by `tests/convex/work.test.ts`, `src/work/evaluate.ts` by `tests/src/work/evaluate.test.ts`. A change to a module changes its mirror in the same commit. Reason: CONTRIBUTING, and the reviewer can find the test without asking. Violates: no mirror for `src/lib/exa.ts`, `src/lib/logger.ts`, `src/memory/workspace.ts`, `convex/voice.ts`, `convex/coworker.ts`.

11.2 A test asserts an observable outcome: a returned value, a row read back through `convex-test`, a message the caller receives, a rendered element. It does not assert that "nothing threw", and it does not assert that a mock was called with the implementation's own internals. Reason: a test that mirrors the implementation passes when the implementation is wrong and fails when it is refactored.
```ts
expect((await readItem(harness, workItemId)).state).toBe('plan-approved');      // tests/convex/work.test.ts:521
expect(timeout).toHaveBeenCalledWith(60_000);                                    // tests/app/api/voice/chat/route.test.ts:277, violates
```
Violates also: `tests/src/docs/system-discovery.test.ts:60` asserts the exact log string from `src/docs/system-discovery.ts:141`.

11.3 Mocks stop at the seam: the model call, the provider transport, the network, the clock. MUST NOT `vi.mock` a project module to reach a branch; inject the dependency instead. Reason: Vitest's own guidance ("use techniques such as dependency injection"), and 51 files currently hand-write `vi.mock('.../src/lib/mastra')` with fakes that drift from each other. A shared fake lives under `tests/convex/fakes/`.

11.4 Nothing in `tests/` reaches a model, a provider or the network. A test that needs a host tool (`python3`, `zip`, `sha256sum`) guards with `it.skipIf` and says why. Follows: `tests/convex/resume-rereads.test.ts:436`.

11.5 A test that schedules Convex work drains it explicitly with fake timers and `t.finishInProgressScheduledFunctions()` or `t.finishAllScheduledFunctions(vi.runAllTimers)`; it never sleeps. Reason: convex-test's documented shape, and the only way the test is deterministic.

11.6 MUST NOT leave `.skip`, `.only`, `.todo` or `.fails` in a committed test without a reason on the same line. A bug fix lands the reproducing test in the same commit as the fix (CONTRIBUTING). Follows: the tree has none.

11.7 Every `describe` name is the module or behaviour; every `it` name is a sentence that states the expected outcome, so the failure line reads as a bug report.

## 12. Docstrings

12.1 MUST put a `/** ... */` TSDoc block on every exported function, constant, type, interface, class and Convex function. First line: one sentence saying what it does, not how. Reason: editors surface it at the call site, and an export with no sentence is one the author could not name. Follows: `src/surfaces/types.ts:12-21`. Violates: `src/lib/exa.ts:14`, `convex/agents.ts:389`.

12.2 MUST NOT repeat type information in the comment. No `{string}`, no "takes a number", no restating a parameter name. Reason: the signature already says it and the two drift.

12.3 `@param name - text` and `@returns text` are written when they add information beyond the name and type, and omitted otherwise. `@throws`, `@remarks`, `@deprecated` (with the replacement) and `@example` where they apply. Reason: TSDoc tag shapes are what tools parse.

12.4 The tree's existing `Args:` and `Returns:` prose sections inside a block are valid TSDoc summary text and stay until the function is next edited; they are not converted mechanically, and new code uses 12.3. Reason: churn without information.

12.5 A Convex function's block says who may call it (public with which guard, or internal) and what it writes. Reason: the wrapper hides both.

## 13. Comments

13.1 A `//` comment states what the code cannot: an invariant, a workaround and its trigger, a decision and its date. It never restates the line below it. Follows: `src/lib/mastra.ts:503-506`. Violates: `app/agent/[agentId]/VoiceRoom.tsx:126` "Auto-scroll transcript to newest utterance."

13.2 MUST NOT commit commented-out code, journal comments or `TODO` without an owner and a ticket. Follows: the tree has no `TODO`, `FIXME` or commented-out code.

13.3 MUST NOT use an em dash in a comment, a docstring or a string. Use a plain dash, a comma or a full stop. Violates: 247 lines, for example `src/env.ts:7`.

## 14. Lint and format as the gate

14.1 Every commit passes `pnpm lint && pnpm typecheck && pnpm test` and every pull request passes `NEXT_PUBLIC_DEV_NO_AUTH= pnpm build`. Reason: CONTRIBUTING and `.github/workflows/gate.yml` run the same four.

14.2 Format is part of the gate. `prettier --check` on `src`, `convex`, `app`, `scripts` and `tests` is added to `pnpm lint` after a single `chore(format)` commit that formats the tree; 323 of 530 files fail today. Until that commit lands, a touched file is formatted in the same change and an untouched one is left alone. Reason: a formatter argument in review is wasted time, and Google's reformatting policy says a file with significant changes is brought into style while opportunistic fixes stay out of focused commits.

14.3 An `eslint-disable` carries the rule and the reason on the same line, in the `-- reason` form. Reason: the next reader sees the reason where the rule is switched off. Follows: `app/setup/page.tsx:386`. Violates: `app/agent/[agentId]/ChatRoom.tsx:175`, `app/agent/[agentId]/AgentDashboard.tsx:186`, `src/lib/mastra.ts:479`.

14.4 MUST NOT use `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error` outside a test that pins a type error. Follows: the tree has none.

14.5 `eslint.config.mjs` is the whole configuration. The `convex/**` override that lowers `no-explicit-any` to warn is dead (no explicit `any` exists there) and is removed. The `react-hooks/set-state-in-effect` override stays until the effects are reworked.

14.6 Planned lint steps, in order, each its own commit: typed linting (`parserOptions.projectService: true`, `tseslint.configs.recommendedTypeChecked`) which turns on 7.6 and 4.4's callback variant; `switch-exhaustiveness-check`; `@convex-dev/eslint-plugin` (version 2.0.0 until `convex` reaches 1.43, then latest) for 10.4; `consistent-type-imports` or `verbatimModuleSyntax` for 1.2 (one error today). `erasableSyntaxOnly` follows once the 45 parameter properties are gone.

## 15. Prose, spelling and emojis

15.1 British spelling in comments, docstrings, commit messages, user-facing copy and documentation (`serialise`, `colour`, `behaviour`). US spelling only inside an identifier or string that mirrors an SDK or protocol. Follows: `src/work/autonomy.ts:29`.

15.2 No emojis in code, comments, copy, commits or documentation. The one permitted occurrence is a unicode round-trip fixture where the emoji is data (`tests/src/lib/credential-crypto.test.ts:71`).

15.3 No em dashes anywhere (13.3 for code; the same for documentation and commits).

## 16. Commits and attribution

16.1 Conventional commits: `type(scope): what the change does`, lower case, no full stop. Types: `feat`, `fix`, `docs`, `test`, `chore`, `build`, `ci`, `refactor`, `perf`, `evidence`. One change per commit; the body says why. Reason: CONTRIBUTING.

16.2 No attribution trailer, no "generated with", no assistant name in a commit, a pull request, a comment or a document. Reason: CONTRIBUTING; the last 200 commits are clean.

16.3 A formatting-only or lint-only change is its own `chore` commit and never rides inside a behaviour change.

## 17. Reviewer checklist

Run down the list on every diff; name the section number in the review.

- 1: named exports, `import type`, no `convex/*.ts` import from `app/` or `src/`, no `app/` import elsewhere, `'use node'` boundary, secrets server-side.
- 2: case by kind, abbreviations as words, file-name convention per directory.
- 3: `interface` for shapes, no `enum`, no `namespace`, no new parameter properties.
- 4: no `any`, no `v.any()` on a read payload, catch as `unknown`.
- 5: every union branch exhaustive by `never` or return type.
- 6: only `Error` thrown, nothing swallowed, `ConvexError` for client-read failures, logger not `console`.
- 7: every promise awaited or returned, `void` only with its comment, no async callback in a void slot, Convex side effects via internal functions.
- 8: `const`, `readonly`, no parameter or module mutation.
- 9: one thing per function, thin Convex wrappers, thresholds questioned.
- 10: layer direction, validators and guards on public functions, indexed and bounded reads.
- 11: mirror test present, outcomes asserted, mocks at the seam, scheduler drained, no skips without a reason.
- 12: TSDoc block on every export, no types in prose.
- 13: comments add information, no em dash.
- 14: gate green, formatted, disables with reasons on the line.
- 15 and 16: British prose, no emojis, conventional commit, no attribution.
