# Terra pilot control — structured-output hardening

Completed 12 September 2026 on disposable project `day0-v5-terra-36a7f9`.
This is a three-task, one-repetition control, not a full Terra re-bed. The v5 label
identifies the structured-output hardening experiment; the driver remains harness v2.

Hosted `gpt-5.6-terra`, Responses API, auto JSON; base URL, output budget and
reasoning effort unset. Mock office, local sandbox, Daytona absent. The deployment
settings were checked before the pilot. Both arms share all 18 parity fields,
including the default two-attempt prompt schema repair.

| Task | New Day0 | Frozen Day0 r1 / r2 / r3 | New ordinary | Frozen ordinary r1 / r2 / r3 |
|---|---|---|---|---|
| docs-team-cadence | pass | pass / pass / pass | pass | pass / pass / pass |
| write-pipeline-row | pass | pass / pass / pass | pass | pass / pass / pass |
| scope-hr-decision | pass | pass / pass / pass | fail | fail / pass / pass |

Day0 **3/3**, ordinary **2/3**: both reproduce frozen Terra repetition 1 on these
tasks. There are no timeouts. All **10 structured calls** (eight task stages and
two onboarding calls) passed first schema validation: **0 invalid first replies,
0 repairs, 0 coercions**. The ordinary tool loop does not use this structured-call
layer. `structured-output.json` has complete task coverage.

Frozen source: `../2026-09-02T13-59-20Z-v3-terra/semifinal.json`. Across the full
frozen comparison, Terra/Sol/8B have 0 recorded terminal schema failures, and
3/0/10 existing semantic repairs. These schema-valid semantic paths are unchanged.
Frozen first-parse and native-fallback counts were not retained and are recorded
as null in `frozen-structured-output-audit.json`. Terra/Sol have no repeated authoring;
8B has ten repeated-authoring rows whose discarded intermediate exceptions cannot
be reconstructed. An unqualified zero-engagement proof for those hidden 8B calls
is unavailable. The new layer is a no-op for identical schema-valid replies; this
pilot is empirical control, not a guarantee that fresh stochastic samples never vary.

`semifinal.md` uses the unchanged report calculations with the new optional parity
label. Tests render all four relevant frozen reports byte for byte. The driver,
graders, task definitions and old result directories remain untouched.
