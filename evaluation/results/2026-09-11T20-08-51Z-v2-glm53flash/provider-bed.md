# Harness v2 hosted model bed — GLM 5.3 Flash through Featherless

**Read the "Why the day0 arm is absent" section before using any number in this directory.**
This bed carries the ordinary (baseline) arm only. The onboarded arm could not be deployed on
this route, and that, not the scores, is the result.

- Evaluation window: 2026-09-11T20:08:52Z to 2026-09-11T20:38:59Z (30 min 07 s), Singapore.
- Harness commit: `0dbcbb32393a0de548d14ba1a240f8e3dac7f7b9`.
- Compose project: `day0-v2-glm53flash-29cdc0`; private volumes `day0-v2-glm53flash-29cdc0_convex_data` and `day0-v2-glm53flash-29cdc0_sandbox_socket`.
- Published ports: Convex 45310/45311, dashboard 47891 (unstarted), fake Slack 45312, model port 45313 unpublished. No model service was started; the operator's `ollama-embed` remained on 11434.
- Model: `zai-org/GLM-5.3-Flash` through `https://api.featherless.ai/v1`, route `@ai-sdk/openai chat-completions through Mastra`. `CONVEX_OPENAI_BASE_URL` was empty, so `./scripts/sync-convex-env.sh` pushed the local base URL to the deployment unchanged.
- Backend/model parity: the fresh deployment reported `zai-org/GLM-5.3-Flash`.
- Served envelope, read from the provider listing on the day: status active, context **262,144**, availability warm, `tool_use` advertised. Price observed 11 Sep 2026: **$0.15 per million input tokens, $0.50 per million output tokens**.
- `contextLimitTokens` is recorded null: `OLLAMA_CONTEXT_LENGTH` was left empty, as on the hosted beds. The served 262,144 is the figure above, not a harness field.
- Skill verification: local networkless sandbox; the deployment environment contained no `DAYTONA_API_KEY`.
- Surface mode: `mock` for the whole bed. It was switched to `real` only afterwards, for the revocation attempt recorded below.
- Design: **one arm** (`baseline`), all 15 tasks, three runs, 45 rows, requested temperature 0.4, no LLM judge.
- Harness v2 contract: 300,000 ms model-call abort, 900,000 ms task deadline, at most six skill-authoring attempts. All recorded parity fields were deep-equal across the configured arms.

## The JSON-mode pin, and why

`OPENAI_JSON_MODE=prompt` was set for every call in this bed and is recorded as
`structuredOutputMode: prompt` in the parity block. The other beds ran `auto`.

The reason is this server's structured-output behaviour, re-verified at 19:22Z on the day of
this bed: `response_format: {type: json_object}` returns HTTP 200 with **empty content**, and
`response_format: json_schema` returns `"This model is busy, please try again later."`
deterministically, sometimes inside an HTTP 200 and sometimes as an HTTP 503. On `auto`, every
structured call would first pay that native attempt; the 503 shape additionally costs five
retries with backoff and then fails the stage outright, because a 5xx is classified as
unrelated to the parameter. On this server `auto` also ends on the prompt rung, so the rung
used is the same in both settings and pinning `prompt` only removes the wasted attempt.

`pnpm probe:model` passed 5/5 required checks twice on the day, with both native rungs declined
and both prompt rungs passing.

## Why the day0 arm is absent

The onboarded arm never deployed. Its preparation step failed in the pilot and again in the
revocation rung:

```
StructuredOutputMissingError: agentJson(day0-charter): model returned no structured object
in prompt mode
    at async synthesiseCharter (../src/agent/charter.ts:432:11)
    at async draftCharter (../convex/onboarding.ts:242:4)
```

Measured at the HTTP level against this endpoint with day0's real charter system prompt and the
seven fixture answers, one variable at a time:

| Output-budget field sent | finish_reason | completion_tokens | content | valid JSON | latency |
|---|---|---:|---:|---|---:|
| none — what day0 sends through Mastra | `length` | 4,096 | 0 chars | no | 56 s |
| `max_completion_tokens: 32768` | `length` | 4,096 | 0 chars | no | 73 s |
| `max_tokens: 20000` | `stop` | 9,381 | 6,113 chars | yes | 138 s |
| `max_tokens: 20000`, repeat | `stop` | 10,316 | 9,030 chars | yes | 147 s |

This endpoint caps completion at **4,096 tokens by default**, accepts `max_completion_tokens`
without honouring it, and honours only the legacy `max_tokens`. GLM 5.3 Flash cannot have its
thinking disabled, and on a charter-sized prompt it spends more than 4,096 tokens thinking: the
truncated responses carried 17,819 and 18,148 characters of `reasoning` and zero characters of
`content`. day0 sends no output budget on the Mastra path, and sends `max_completion_tokens`
(which this server ignores) on the raw path, so every large-output structured call on this
route returns nothing.

Small-output calls are unaffected, which is why `pnpm probe:model` passes 5/5, `check:setup`
reports the model ok, and the whole ordinary arm runs. The boundary is output size, not the
route.

No `src/` change was made to work around this, and no rewriting proxy was placed in front of
the endpoint. Either would have produced numbers for a configuration the demo does not have.

## What the ordinary arm shows

45/45 rows present, 39 terminal `completed`, 24 graded passes, **zero harness timeouts, zero
deadline overruns, maximum overrun 0 ms, zero skill-authoring attempts** (0 attempts × 45).

One row, `baseline-r3 docs-salesforce-escalation`, ran to 300.1 s and ended `failed`: that is
the 300,000 ms per-call abort, not a task deadline.

Per-task wall: minimum 3.5 s, median 16.9 s, maximum 300.1 s, 30.1 minutes in total.

## Transient errors and the budget

**Zero** `hit transient error` lines, zero HTTP 429 and zero HTTP 503 reached the retry policy
during the bed. No call returned 402. The pre-paid balance was never topped up.

Token cost is not a harness field (report section 5.5) and the provider exposes no usage
endpoint to an API key — `/usage` answers 401 to a bearer token and needs a dashboard session —
so the exact figure must be read from the Featherless usage page for the window 20:08Z-20:39Z
on 11 Sep 2026. What can be stated from measurement: this endpoint generated at 68-73 output
tokens per second in every timed call, so 30.1 minutes of task wall bounds the bed above at
roughly 126,000 output tokens, about **$0.06 of output and a similar order of input**, against
the $12 the report priced a two-arm 90-row bed at. The bed came in far under budget because
only one arm ran and the ordinary arm's calls are short.

## Retained files

- `semifinal.json`: the 45 raw rows and the full parity block.
- `semifinal.md`: the rendered report. Its day0-arm rows read "not estimable (0/0)" because that arm has no rows, not because a measure failed.
- `backend-run.log.gz`: complete backend-container log from isolated project startup through the pilots, the bed, the gate and the revocation attempt; 832 lines.
- `revocation-blocked.md`: the model-free rungs, what ran and what did not.
- `SHA256SUMS`.

## Related directories

- `evaluation/results/2026-09-11T19-24-41Z/`: the two-arm pilot that failed at charter synthesis.
- `evaluation/results/2026-09-11T19-56-20Z/`: the one-run baseline pilot that passed, three tasks in 39 s.
- `evaluation/gate/2026-09-11T20-45-23Z/`: the gate matrix run for this bed.
