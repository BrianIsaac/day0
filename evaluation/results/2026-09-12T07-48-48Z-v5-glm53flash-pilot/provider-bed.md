# GLM 5.3 Flash re-bed pilot — structured-output hardening

Completed 12 September 2026 on disposable project `day0-v5-glm53flash-4ad4c9`,
backend `http://127.0.0.1:45710`. Three tasks, one repetition, both arms: the
gate the brief requires before spending the full bed. The v5 label identifies the
structured-output hardening experiment; the driver remains harness v2.

Featherless `zai-org/GLM-5.3-Flash`, prompt-mode JSON, 32,768-token output budget,
reasoning effort low, mock office, local sandbox, Daytona absent. The deployment
was read back independently before the first model call and carried all eight
settings, including `OPENAI_STRUCTURED_REPAIR_ATTEMPTS=2`, the shipped default.
Both arms share all 18 parity fields.

| Task | Day0 | Ordinary |
|---|---|---|
| docs-team-cadence | pass | pass |
| write-pipeline-row | pass | pass |
| scope-hr-decision | pass | fail |

Day0 **3/3**, ordinary **2/3**, reproducing the paired bed's pilot on the same
three tasks. The Day0 charter was requested at 07:49:03.814Z and approved at
07:49:04.642Z, a 751 ms scripted delay; every downstream stage ran under an
approved charter.

Structured-output record (`structured-output.json`): **10 calls, 1 invalid first
reply, 1 repair attempt, 0 coercions, 0 failed calls**. The single repair was a
`day0-skill-author` call inside `scope-hr-decision`, corrected on its first extra
attempt and then valid; the row passed. The other nine calls took the unchanged
path. The ordinary tool loop does not use this structured-call layer.

No 402, no persistent 429, no timeout and no deadline overrun. The pilot is
sealed separately from the full bed that follows it.
