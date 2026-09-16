# Interfaces

The contracts a third party reuses, extends or calls, and where each one is defined in the code. Everything here is read from the tree at the commit you have checked out; the file paths are the authority, and this page is the map. The README's [Convex backend](../../README.md#convex-backend-convex), [Schema](../../README.md#schema-convexschemats) and [Domain logic](../../README.md#domain-logic-src) tables list every module; this page covers the shapes that cross a boundary.

Contents: [the Convex function surface](#the-convex-function-surface) · [the skill contract](#the-skill-contract) · [the surface record](#the-surface-record) · [action shapes](#action-shapes) · [the exact-action policy](#the-exact-action-policy) · [the adapter interface](#the-adapter-interface) · [the ledger row and the export](#the-ledger-row-and-the-export) · [permission grants](#permission-grants)

## The Convex function surface

Every backend operation is a Convex query, mutation or action under `convex/`. The public ones take the caller's identity from the auth provider (Clerk, or the local no-auth token) and check ownership of the agent they touch through `convex/ownership.ts`; the internal ones are reachable only from other functions and from the scheduler.

The full argument and return schema of the deployed functions comes from the Convex CLI against a running deployment:

```bash
npx convex function-spec                 # the deployment named in .env.local
npx convex function-spec --file spec.json
```

To call a public function from the command line on the local no-auth stack, present the local owner's identity; without it every per-agent function refuses as not authenticated, which is the ownership check doing its job:

```bash
npx convex run agents:list '{}' --identity '{"subject":"dev-no-auth|local-boss"}'
npx convex run exportActions:exportForAgent '{"agentId":"<id>"}' --identity '{"subject":"dev-no-auth|local-boss"}'
```

The entry points a reader is most likely to want:

| Function | Kind | What it does |
|---|---|---|
| `agents:deploy` | mutation | Creates an agent and seeds its first grants |
| `charters:approve`, `charters:amend` | mutation | Approves a drafted charter with the manager's strikes; amends an approved one as a new version |
| `work:approvePlan`, `work:decideActions`, `work:retry` | mutation | The manager's decisions on a plan, on held actions and on a finished run |
| `skills:approve`, `skills:reject` | mutation | The manager's decision on a proposed skill |
| `surfaces:approveByManager`, `surfaces:approveByIt` | mutation | The two approvals a connection card needs |
| `agents:revokeScope`, `agents:setAutonomousActions` | mutation | Revoke a grant; turn the autonomy switch |
| `metrics:forAgent` | query | The Supervision card's numbers, derived from the event ledger |
| `exportActions:exportForAgent` | action | The whole event trail and ledger as JSON, credential values removed |
| `reset:deleteMyData` | mutation | Deletes the caller's agents and their rows in the enumerated tables |

Names are `module:function`; confirm the current argument shape with `function-spec` rather than from this table, which is a guide to where to look.

## The skill contract

A skill is a Markdown procedure the agent can be handed at execution. The one that ships, `see-internal-docs`, is installed at deploy from `convex/seed.ts`; every other skill is authored by the agent, in response to a work item that matched no registered skill, and is callable only after it has been verified in a sandbox. The registry is the `skills` table in `convex/schema.ts`, keyed by surface class and operation, with seven states:

```
proposed → approved → authoring → registered
                              ↘ failed (retryable)
proposed / approved / authoring → rejected
```

`verified` also exists as a state name for rows written before verification and registration became one step; it is not a resting state any more.

**Name.** `<surface-class>-<operation>`, from `src/work/skill-shape.ts`. The surface classes are the taxonomy in `src/agent/system-classes.ts`: `kanban`, `chat`, `docs`, `spreadsheet`, `crm`, `analytics`, `social`, `other`. The operation is the one the linked runbook documents for that class (`comment-and-close`, `thread-reply`, `refresh-value`, `append-row`, `reply`, `update-record`, `answer-from-docs`, `action`), or `read` for an explicitly read-only request. A skill is named for its shape, never for the ticket or thread that first needed it.

**Body.** A `SKILL.md` with these sections, in this order, and the authoring prompt in `convex/skillActions.ts` asks for exactly them:

| Section | Contents |
|---|---|
| `## When to invoke` | The condition, taken from the runbook, not a restatement of the charter |
| `## Inputs` | Every value that varies per run, as an angle-bracket placeholder |
| the procedure | Numbered steps that use the placeholders |
| `## Verification` | How the run checks what it did |
| the actions it emits | The typed actions of the [action shapes](#action-shapes) below |

**Placeholders.** An input is two or more lower-case words joined by hyphens, in angle brackets: `<record-id>`, `<requested-value>`, `<reply-thread>`. The grammar and the declaration rule are in `src/work/skill-inputs.ts`. Under `## Inputs`, a placeholder is declared by a list item or table row that starts with it, in any of four spellings (`<record-id>`, `` `<record-id>` ``, `` `record-id` ``, `record-id`), or by writing the angle-bracket form anywhere in the section. Every use in the body keeps the angle-bracket form. `{{secret}}` is the one permitted double-brace token, for a credential the transport injects; anything else in double braces is refused.

**Binding.** At execution `bindSkillInputs` in `src/work/skill-inputs.ts` fills the declared inputs from the work item and its surface record: `<record-id>` from the item's external id, `<originating-surface>` from its source system, `<reply-channel>` and `<reply-thread>` from its reply target. Any other input is handed to the executor with the instruction to read it from the candidate, its references or the runbook for this run. A skill body carries no per-run value of its own.

**The static gate.** Before any sandbox runs, `authoredSkillIssues` in `src/work/authored-skill.ts` refuses a body or smoke test that has no `## Inputs` section, uses a placeholder it does not declare, or repeats the first work item's values: its external id, its content references, its reply channel or thread, and any percentage, currency amount, whole number or quoted phrase from its title and summary. A quoted `click`, `press` or `select` control is allowed when the linked runbook names it; a quoted output value is not. The refusal reason lands on the skill row, with the refused draft kept redacted and bounded, and the retry hands both back to the author and asks for one corrected replacement.

**The smoke test.** A `smoke.py` beside the body. It runs in a fresh Python 3.12 with no third-party packages and no network, so it mocks every external call. It must define `run(inputs: dict) -> dict`, call it once for each of two different representative input sets (neither of them the first work item's values), and print one line per call that includes a value from that call's output. `src/lib/skill-sandbox.ts` registers the skill only when the process exits 0 within the 60-second cap and printed at least one distinct non-empty line per input set. A preflight in `src/work/smoke-test.ts` refuses a file that does not parse, lacks the `run` signature or never prints, before the sandbox is asked. The sandbox is the bundled local service (`sandbox/`, reached over a unix socket, no network, read-only root, unprivileged user) or Daytona when `DAYTONA_API_KEY` is set; `src/lib/daytona.ts` applies the same 60 seconds.

## The surface record

In real mode every system the documentation names becomes one row in the `surfaces` table (`convex/schema.ts`), per agent. The executor sees the subset typed as `SurfaceRecord` in `src/surfaces/types.ts`.

**Verdict.** The row's lifecycle field is `verdict`:

```
declared → proposed → approved → connected
                              ↘ ungranted   (a probe the credential could not pass)
                              ↘ listed-dead (a documented endpoint that does not answer)
absent                                        (no approved path in the documentation)
```

`src/surfaces/verdict.ts` re-derives `connected` from the last successful re-probe, so a row goes stale after six hours without one.

**Path.** The connection ladder is `SURFACE_PATHS` in `src/surfaces/types.ts`: `mcp`, `documented-api`, `browser-driven`, `escalate`. Orientation writes the chosen `path`, a `fallbackPath` and the `pathCandidates` it considered, each with the endpoint the documentation records; the probe records each attempt's outcome in `probeAttempts`.

**Approvals and credential.** `managerApprovedAt` and `itApprovedAt` are the two approvals a card needs before its probe runs. The credential is a reference, `credentialId`, into the owner-level `credentials` table, with `credentialKind` (`value`, `location` or `oauth`) and `credentialLanded`; the row never holds a credential value.

**Tool catalogue.** `toolAllowlist` is the list of tools the probe discovered and admitted, and `toolArguments` the argument names it probed per tool. The policy refuses any action naming a tool outside the allowlist, and the executor is shown the probed argument names so a held write is repaired once against them before it is held.

**Evidence and intake.** `discoveryEvidence` carries the charter and documentation sentences the card was proposed from. `waterfallPosition`, `lastPolledAt` and `lastDecisionPolledAt` are the intake and manager-decision checkpoints.

## Action shapes

Every effect the agent proposes is a literal action, parsed and held before it reaches an adapter. The verb sets are constants in `src/work/types.ts`; the schema the model emits is `generatedActionSchema` in `src/work/execute-skill.ts`; the parsed shapes the gate holds are in `src/surfaces/policy.ts`.

**Mock mode**, against the seeded office:

| Tool | Arguments |
|---|---|
| `spreadsheet.appendRow` | `sheetSlug`, `tabName`, `cells: [{ header, value }]` |
| `slack.postMessage` | `channelSlug`, `threadKey` or null, `body` |
| `twitter.reply` | `tweetSlug`, `body` |
| `ticket.update` | `slug`, `status` (`open`, `in-progress`, `blocked`, `done`) or null, `comment` or null |

**Real mode**, against connected surfaces:

| Tool | Arguments | Allowed on |
|---|---|---|
| `mcp.call` | `surface`, `tool`, `toolArgsJson` | an `mcp` or `browser-driven` surface |
| `http.request` | `surface`, `method` (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`), `path`, `headersJson` or null, `body` or null | a `documented-api` surface |

A mock verb in real mode, or a real verb in mock mode, is refused. The serialised action is capped at 16 KiB.

**Browser operations** are not a third verb. They are `mcp.call` against a `browser-driven` surface, and the tool name must be one of `BROWSER_TOOLS` in `src/surfaces/browser.ts`: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`. `browser_navigate` is bound to the surface's documented origin. A runbook sequence that needs several of them is held as one batch, because the steps cannot be split across isolated browser sessions, and the last step's snapshot is the read-back the ledger records.

**Idempotency.** An action carries no key of its own; the registry derives `<workItemId>:<runId>:<actionIndex>` in `src/work/idempotency.ts`, so a retry of the same run re-presents the same key to the provider.

## The exact-action policy

`reviewAction` in `src/surfaces/policy.ts` gives every parsed action one of three dispositions:

| Disposition | Meaning |
|---|---|
| `auto` | applies without a human step |
| `held` | waits for the manager to approve this literal payload |
| `refused` | can never be applied, and the reason says why |

Refusals come first: a malformed action, an unknown or unconnected surface, a verb on the wrong path, a tool outside the allowlist, a missing grant (`no grant (<scope>)`), a status change without its audit comment. What is left is classed as `read`, `manager-dm`, `public-post`, `mutation` or `write`. With the autonomy switch off, reads and the manager's DM apply and every write is held. With it on, an in-policy write applies as well, unless its scope has been revoked.

**Scopes.** An action needs `<surface>:read` or `<surface>:write`, named for the surface slug and the action's intent (`requiredScope`). The manager's DM is authorised by `boss:message` alone. A GET or HEAD without a body is a read; anything else, and any compound or unknown MCP tool name, is a write.

**Authority.** An applied row records who authorised it, as `ActionAuthority` in `src/surfaces/types.ts`: `manager` for a payload the manager approved by index, `autonomous` for one the switch let through, `standing` for a read or DM under a standing grant. A `manager` approval is its own authority: revoking the standing write scope afterwards does not cancel a write the manager already approved literally, and the ledger says so. A write authorised only by the switch is refused the moment its scope is revoked.

## The adapter interface

An adapter is what turns an approved action into an effect on one kind of surface. `src/surfaces/registry.ts` maps each verb to one, and the interface is `SurfaceAdapter` in `src/surfaces/types.ts`:

```ts
interface SurfaceAdapter {
  readonly tools: readonly ActionTool[];
  read(ctx, agentId): Promise<Partial<SurfaceSnapshot>>;
  apply(ctx, run, action, index, idempotencyKey): Promise<AppliedAction>;
  close?(): Promise<void>;
}
```

Mock mode registers the single mock adapter for the four mock verbs. Real mode constructs `McpAdapter` (`src/surfaces/mcp.ts`) and `HttpAdapter` (`src/surfaces/http.ts`), each declaring its one verb, with the dependencies in `RealAdapterDeps`: `decrypt` for the surface's credential, `createMcpClient`, `fetch`, an optional `beforeTransport` hook (where authority is re-read immediately before the provider call), the browser component's URL, and the redaction inputs. The pipeline in `applySurfaceActions` runs parse, surface and path checks, allowlist, reply target, grant, disposition, comment-before-status and provenance before it calls `adapter.apply`, and stamps the authority on the row afterwards. To add a verb, implement the interface and add it to that map; there is no runtime plugin hook, by design.

## The ledger row and the export

An applied action is recorded as an `AppliedAction` (`src/surfaces/types.ts`):

| Field | Meaning |
|---|---|
| `tool`, `idempotencyKey` | which action, under which key |
| `ok` | whether the provider accepted it |
| `effect` | what changed, with provider identifiers redacted |
| `reason` | why it was held or refused |
| `held`, `awaitingApproval`, `outcomeUnknown` | the states short of an applied effect |
| `authority` | `manager`, `autonomous` or `standing` |
| `providerId` | the provider's identifier for the landed object |
| `redaction` | `structural-only` when the redaction component was not available |
| `repair` | the one argument-name repair made before the hold, if any |

Rows live on the work item's `output.applied` and in the `work.completed` event, and `convex/metrics.ts` de-duplicates them by idempotency key to derive the Supervision card. `exportActions:exportForAgent` returns the agent, its events, its ledger and the names of the credentials it held, with owner addresses dropped, token shapes scrubbed and every credential value the owner stored removed before the JSON leaves the backend. The internal query it wraps, `events:exportForAgent`, is not callable from outside.

## Permission grants

Grants are rows in `permissionGrants`, scoped and revocable, with a `source` of `deploy`, `manager`, `skill` or `surface`. Deploy seeds `boss:message` and the read scopes of the mode: in mock mode the five office reads (`docs:read`, `spreadsheet:read`, `social:read`, `ticket:read`, `slack:read`), in real mode `docs:read` alone, because there is no surface to read until one connects. A surface's `<slug>:read` is granted when it first connects; its `<slug>:write` is proposed by the skill that needs it and granted by the manager. Revocation is `agents:revokeScope`, is recorded as an event, and is re-checked at evaluation, at apply and immediately before transport.
