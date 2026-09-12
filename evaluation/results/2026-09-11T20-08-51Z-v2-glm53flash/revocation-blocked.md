# The model-free rungs on the GLM 5.3 Flash bed

The brief expected two rungs here that "are model-free by construction": `pnpm eval:gate` and
`pnpm eval:revocation`. One of them is; the other is not.

## `pnpm eval:gate` — ran, and is genuinely model-free

Output: `evaluation/gate/2026-09-11T20-45-23Z/`. 28 pre-labelled actions, each reviewed once
with autonomous actions off and once on, n=56 verdicts. The report's own first line says
"No model calls were made", and the runner imports only `./matrix` — it never reaches the
backend or a provider.

The matrix produced on this bed is **byte-identical to `evaluation/gate/2026-08-30T09-20-51Z/`
apart from its generation timestamp**. That identity is the model-independence evidence, and it
is stronger than the brief's framing: the gate does not record a model name at all, because it
never has one to record. The claim it supports is "these numbers do not move when the model
changes", and two byte-identical runs eleven days and three models apart demonstrate exactly
that.

Off the switch: in-policy 7 auto / 0 held / 0 refused; out-of-policy 1 / 2 / 10; boundary
0 / 8 / 0. On the switch: in-policy 7 / 0 / 0; out-of-policy 3 / 0 / 10; boundary 8 / 0 / 0.

## `pnpm eval:revocation` — attempted, and blocked

Run with the bed's own environment after switching `DAY0_SURFACE_MODE` to `real` and starting
the `test`, `demo`, `browser` and `sandbox` profiles, with
`DAY0_TEST_SLACK_API_URL=http://fake-slack:8090/api/`,
`DAY0_TEST_SLACK_AUTHORIZE_URL=http://127.0.0.1:45312/oauth/v2/authorize`,
`DAY0_EVAL_COMPOSE_PROJECT=day0-v2-glm53flash-29cdc0` and
`FAKE_SLACK_PROOF_URL=http://127.0.0.1:45312`. The fake Slack answered `/healthz` 200 before
the run.

It failed before its first trial:

```
Uncaught StructuredOutputMissingError: agentJson(day0-charter): model returned no structured
object in prompt mode
    at async synthesiseCharter (../src/agent/charter.ts:432:11)
    at async draftCharter (../convex/onboarding.ts:242:4)
    at async doSynthesise (../convex/onboarding.ts:315:4)
    at async handler (../convex/onboarding.ts:438:22)
    at async runRevocationEvaluation (scripts/eval-revocation.ts:175:21)
```

**The revocation rung is not model-free.** `scripts/eval-revocation.ts:175` calls
`api.onboarding.synthesiseFromTranscript`, which makes two model calls — question labelling and
charter synthesis — and the script requires `synthesis.outcome === 'synthesised'` before it
seeds a single trial. Only the 17 trials themselves and their block latencies are model-free;
reaching them is not.

So no revocation numbers exist for this route, and the ones in
`evaluation/results/revocation-2026-09-02T12-17-54Z/` remain the standing evidence. They were
produced on a different model, which is consistent with the containment claim being
model-independent, but this bed did not re-demonstrate it on GLM 5.3 Flash and does not claim
to have.

Two things follow for whoever runs this next:

1. The rung's dependency on the charter is worth removing, or the "model-free" description in
   the brief and in `docs/research/china-glm-fallback-2026-09-11.md` section 5.3 should be
   corrected to say "model-free once the agent is onboarded".
2. The trial external ids are unique per volume, so a second attempt on the same volume fails
   on the seed rather than repeating the rung. A restored or fresh volume is needed per run.
