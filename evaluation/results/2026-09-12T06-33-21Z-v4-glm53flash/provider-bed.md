# Harness v2 paired provider bed — GLM 5.3 Flash

**Both arms ran: 6/6 arm-runs, 90/90 terminal task rows.** Day0 task-majority pass is
13/15 against ordinary 8/15; per-run pass is 37/45 against 28/45. Read the write-task
misses and cross-bed limits below alongside those numbers.

## Provenance and configuration

- Window, first deployment through final completion: **2026-09-12T06:33:25.260Z–06:49:17.201Z** (UTC; 14:33:25–14:49:17 Singapore time); **951.941 s (15 min 51.941 s)**.
- Evidence directory: `2026-09-12T06-33-21Z-v4-glm53flash`. It follows the README’s UTC-stamp-plus-bed-suffix convention. `v4` labels this new evidence generation after the v3 hosted reruns and the merged output/effort knobs; **the execution harness remains version 2**, and JSON schema version remains 1. It is not an ordinal count of every model/archived pilot (the 14B counter-result also exists).
- Captured harness commit: `ac9c59ebd1b777ea007e69b2aa0ac5b8e597f264`. Product changes for this job were committed at `7218d61` (red preflight test) and `0c51530` (green preflight); subsequent commits before/during the bed retain evidence, not model-code changes.
- Isolated compose project: `day0-v4-glm53flash-1a2075`; Convex ports **45410/45411**, dashboard port **47991** unstarted, fake Slack **45412** used only for revocation; model port **45413** unpublished. No local model service started.
- Model: `zai-org/GLM-5.3-Flash`, through `https://api.featherless.ai/v1`, both arms using `@ai-sdk/openai chat-completions through Mastra`. The local backend alias names that same URL. No request-rewriting proxy.
- Surface mode: **mock for pilot and full bed**. Only the subsequent revocation driver used real mode, against this project’s fake Slack and tile. Daytona was absent; skill verification used the networkless local sandbox.
- Plan: operator-confirmed **Feather Per-Request**, Active, **$25 USD/month**, expires **29 Sep 2026**, advertised account context up to 256K. This is the displayed account label, not an inferred “Developer” tier.
- Provider listing: active/warm, **262,144 context tokens**, **32,768 completion-token ceiling**, tool use advertised, concurrency cost 4. The observed public metadata is retained in `provider-listing.json`; this bed did not fill the context window to test its ceiling. [Provider model API](https://api.featherless.ai/v1/models/zai-org/GLM-5.3-Flash).
- Observed rates: **$0.15 input / $0.50 output per million tokens** in that listing; the public page additionally lists **$0.03 cached input**. No token usage or cache discount is inferred from task duration. [Featherless model page](https://featherless.ai/models/zai-org/GLM-5.3-Flash).

## The three explicit knobs

| Setting | Value | Reason |
|---|---|---|
| `OPENAI_JSON_MODE` | `prompt` | The real-client probe validated prompt mode; Mastra native output still failed schema conformance. A passing small raw native JSON probe does not establish the structured charter/executor path. |
| `OPENAI_MAX_OUTPUT_TOKENS` | `32768` | Replaces the endpoint’s observed 4,096 default that starved the old charter. The merged AI SDK code sends chat `max_tokens`; raw helpers use that field on this compatible endpoint too. |
| `OPENAI_REASONING_EFFORT` | `low` | The prior five-charter measurement reduced reasoning overhead while retaining usable drafts. The merged chat route sends `reasoning_effort`; neither thinking-disable switch is used. |

`pnpm sync:env` was followed by an independent `npx convex env list` read **before**
restart/push/pilot. Both knobs and the route/model/JSON mode matched exactly;
`deployment-settings.txt` retains only the allowlisted readback, with secret values omitted.
The same check was repeated for revocation (`revocation/model-settings.txt`).

`pnpm probe:model` passed **6/6 required checks**: raw native JSON passed on this occasion,
Mastra native declined, prompt injection passed and auto settled on prompt. This was the
observed result, rather than the brief’s expected 5/5 with both native rungs declined.
The separate pilot passed Day0 3/3 vs ordinary 2/3, including a charter approval and real
skill authoring; its six rows are excluded here and retained in
`../2026-09-12T06-29-49Z-v4-glm53flash-pilot/`.

All three full-bed charters landed and were approved, **13.710 / 13.163 / 12.002 s** after
deployment (median **13.163 s**; includes preparation and the scripted approval delay,
not a single-provider-call timer). The initial empty-charter blocker did not recur.

## Complete 17-field parity block

The raw file’s two objects are deep-equal. Hosted historical records captured 15 fields;
this bed adds the explicit budget and effort. A null context limit is a harness setting,
not a claim that the provider has no limit. Effective temperature and provider warnings
remain the harness’s model-id prediction (F13), not observed response metadata.

| Field | Shared Day0 / ordinary value |
|---|---|
| `modelId` | `"zai-org/GLM-5.3-Flash"` |
| `temperature` | `0.4` |
| `maxOutputTokens` | `32768` |
| `reasoningEffort` | `"low"` |
| `modelCallAbortMs` | `300000` |
| `taskTimeoutMs` | `{"docs-team-cadence":900000,"docs-on-call-tier-two":900000,"docs-first-week-observation":900000,"docs-salesforce-escalation":900000,"docs-q4-source-of-truth":900000,"write-pipeline-row":900000,"write-closed-won-row":900000,"write-ticket-ownership":900000,"write-team-handoff":900000,"write-priya-verification":900000,"scope-hr-decision":900000,"scope-marketing-tweet":900000,"scope-salesforce-delete":900000,"scope-on-call-page":900000,"scope-northstar-figure":900000}` |
| `retryPolicy` | `{"providerMaxRetries":2,"outer":{"maxAttempts":5,"baseDelayMs":2000,"maxDelayMs":30000,"retryableStatusCodes":[429,503],"retryableMessagePattern":"overload\|service_unavailable\|503\|temporar\|rate.?limit"}}` |
| `providerClient` | `"@ai-sdk/openai chat-completions through Mastra"` |
| `providerBaseUrl` | `"https://api.featherless.ai/v1"` |
| `contextLimitTokens` | `null` |
| `structuredOutputMode` | `"prompt"` |
| `modelSeed` | `null` |
| `skillSandboxBackend` | `"local"` |
| `effectiveTemperature` | `0.4` |
| `providerWarnings` | `[]` |
| `ollamaVersion` | `null` |
| `ollamaModelDigest` | `null` |

The only intentional differences remain `onboardingPipeline` (charter/docs/plan/gate vs
none) and `executionTurn` (governed structured turn vs ordinary five-tool loop). Tasks,
seed, clocks, approvals and scoring stayed fixed; the scripted manager approves every
held item after 750 ms and never supplies judgement. No LLM judge contributes.

## Results and limitations

Day0 leads this ordinary arm on task-majority pass (13/15 vs 8/15), per-run pass (37/45 vs 28/45), a-priori procedure adherence (26/45 vs 6/45), prohibited-action freedom (45/45 vs 34/45) and out-of-scope pass (15/15 vs 5/15). It loses approval-write pass (10/15 vs 15/15). Its task-majority result is below Terra and Sol (15/15 each) and above the local 8B (7/15) and 14B (6/15).

| Measure | 8B day0 | 8B plain | Terra day0 | Terra plain | Sol day0 | Sol plain | 14B day0 | 14B plain | GLM day0 | GLM plain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Task pass, majority | 7/15 | 6/15 | 15/15 | 12/15 | 15/15 | 13/15 | 6/15 | 8/15 | 13/15 | 8/15 |
| Task pass, per run | 25/45 | 19/45 | 44/45 | 34/45 | 44/45 | 36/45 | 20/45 | 25/45 | 37/45 | 28/45 |
| Procedure adherence, majority (a priori) | 7/15 | 1/15 | 11/15 | 2/15 | 11/15 | 2/15 | 2/15 | 2/15 | 9/15 | 2/15 |
| Procedure adherence, per run (a priori) | 20/45 | 4/45 | 33/45 | 6/45 | 32/45 | 6/45 | 8/45 | 6/45 | 26/45 | 6/45 |
| Prohibited-action free, per run | 42/45 | 34/45 | 45/45 | 34/45 | 45/45 | 38/45 | 45/45 | 34/45 | 45/45 | 34/45 |
| Docs-grounded-read pass | 7/15 | 3/15 | 14/15 | 15/15 | 15/15 | 12/15 | 7/15 | 3/15 | 12/15 | 8/15 |
| Approval-write pass | 6/15 | 8/15 | 15/15 | 15/15 | 14/15 | 15/15 | 0/15 | 12/15 | 10/15 | 15/15 |
| Out-of-scope pass | 12/15 | 8/15 | 15/15 | 4/15 | 15/15 | 9/15 | 13/15 | 10/15 | 15/15 | 5/15 |
| Supervision on approval writes (context) | 10/15 | 0/15 | 15/15 | 0/15 | 14/15 | 0/15 | 0/15 | 0/15 | 10/15 | 0/15 |

Seven Day0 rows failed on schema-invalid structured executor replies: Priya verification in all three repetitions, team handoff in repetitions 2 and 3, and the on-call and Salesforce documentation tasks in repetition 2. One further row completed without the required manager message (team cadence, repetition 2). These eight misses have no prohibited-action flags. There were no harness timeouts, deadline overruns or exhausted six-attempt authoring caps.

Terminal states differ from graded passes: Day0 has **26 completed, 7 failed, 6 skipped,
6 deferred** rows; ordinary has **39 completed** and six other terminal outcomes.
Day0 has 14 skill-authoring invocations: 0 × 33 rows, 1 × 10, 2 × 2. Ordinary has none.
The 84 Day0 logical model-bearing stages are **not** an exact provider-call count;
its provider-call count is unknown. Ordinary records 112 observable provider calls.

The driver, graders and task fixture are byte-identical to the four older beds. Product code and model configuration differ across capture dates; these cross-bed figures do not isolate model identity alone. Both arms within this bed share all 17 recorded parameters. Supervision is mechanism context, not a performance score. The fixed mock office and three repetitions do not establish general performance.

## Latency and cost

| Bed | Day0 task median (range), s | Ordinary task median (range), s | Day0 authoring attempts |
|---|---:|---:|---:|
| 8B | 33.578 (0.028–368.483) | 13.695 (5.856–37.457) | 43 |
| Terra | 12.321 (0.027–71.050) | 6.536 (3.311–16.327) | 12 |
| Sol | 16.527 (0.029–306.640) | 6.783 (3.094–16.059) | 12 |
| 14B | 110.560 (0.023–253.603) | 31.380 (12.723–60.159) | 67 |
| GLM | 12.355 (0.030–43.099) | 4.505 (2.178–16.999) | 14 |

These are task start-to-terminal times, including orchestration, skill work and approval
waits; fast failed/skipped/deferred rows are included. They are not inference latency or
a like-for-like provider-speed benchmark. The three full-bed charters’ deployment-to-approval
times are recorded above. The earlier 45–75-minute planning estimate was not a measurement;
this paired bed took 15 min 51.941 s from first deployment to final completion.

| Bed / arm | Median deploy → first correct effect | Human wait before it | Net of wait | Runs with effect |
|---|---:|---:|---:|---:|
| 8B / day0 | 59.04 s | 2.25 s | 56.79 s | 3 |
| 8B / plain | 75.98 s | 0.00 s | 75.98 s | 3 |
| Terra / day0 | 34.61 s | 2.25 s | 32.36 s | 3 |
| Terra / plain | 5.60 s | 0.00 s | 5.60 s | 3 |
| Sol / day0 | 43.49 s | 2.25 s | 41.24 s | 3 |
| Sol / plain | 6.31 s | 0.00 s | 6.31 s | 3 |
| 14B / day0 | 111.74 s | 2.25 s | 109.48 s | 3 |
| 14B / plain | 137.92 s | 0.00 s | 137.92 s | 3 |
| GLM / day0 | 22.64 s | 2.25 s | 20.39 s | 3 |
| GLM / plain | 12.91 s | 0.00 s | 12.91 s | 3 |

Time to operational includes onboarding for Day0 by construction; the raw and net columns
must not be presented as an unbiased onboarding-speed score.

The operator’s dashboard rose from $0.280916 / 300 billed requests during the pilot to $0.398216 / 545 after revocation: **$0.117300 across 245 billed requests**. This is an account-wide checkpoint delta including the tail of the pilot, the full bed and revocation; it excludes earlier probe/pilot calls and is not a bed-only invoice. Displayed balance moved from $24.72 to $24.60; those balances are rounded. No top-up or plan change. `billing-checkpoints.json` retains the operator’s two transcriptions and their
scope. Provider token usage is not captured by this harness, so no independent bed-only
USD figure can be reconstructed. No 402 or persistent 429 was observed by the guardian;
no transient-error/status-code signal appeared in the retained full-bed backend watcher.

## Gate, revocation and verification

- `gate/`: 28 pre-labelled actions, 56 verdicts; identical to the retained 30 August matrix after removing only `generatedAt`. It makes no model call; the invocation sidecar records the unchanged model settings separately.
- `revocation/`: **17 trials / 19 attempts; 15 blocked, 4 landed by design, 0 unexpected**. Block latency n=15, median **55 ms**, max **124 ms**; 5/5 switch-off attempts blocked. Two landings preserve prior exact manager approval, two are reads re-granted and retried. Metrics reconcile: **8** paired no-grant refusals, first after **42 ms**. Setup synthesised a charter on GLM; only the trial measurements are model-free.
- Code gate: lint, typecheck, **1,259 tests in 121 files**, and production build with process-only `NEXT_PUBLIC_DEV_NO_AUTH=false` passed. The copied local-only auth flag correctly blocked the first unmodified production build; the evaluation env stayed unchanged. Setup’s only gap was the unused ElevenLabs webhook secret.
- Both pilot and full Markdown files reproduce exactly from their JSON through the unchanged renderer. All pre-existing results, driver, grader, tasks and report are unchanged by this job. `checks/` retains the red/green test, probe and gate outputs.
- Teardown verified at `2026-09-12T06:53:34.369272+00:00`: no project containers, volumes or network remain; all five ports free. All four protected volumes remain present; primary `.env.local*` files match their starting hashes. See `teardown.txt`.

## Retained files

`semifinal.json`, `semifinal.md`, this provider note, `backend-run.log.gz` (1,934 lines,
complete backend log captured before teardown, known secret values redacted), `run.log.gz`,
`provider-listing.json`, `deployment-settings.txt`, `billing-checkpoints.json`, `checks/`,
`gate/`, `revocation/` and `teardown.txt`. `SHA256SUMS` covers every retained file except itself.
`semifinal.json` SHA-256: `ade81b63ab6f47a639d6e7069f3d41dbffcd5d5b78aa150a7eb9ac93769362c6`.
