# GLM paired pilot — 12 September 2026

This is the one-repetition, three-task pilot, retained separately from the full bed.
Day0 passed docs-team-cadence, write-pipeline-row and scope-hr-decision (3/3).
The ordinary arm passed the first two and failed scope-hr-decision (2/3).
Both arm-runs completed; all six terminal rows are recorded; no harness timeouts or
budget-stop signals occurred. The Day0 charter was approved 24.056 s after deployment.
Day0 authored one skill for the pipeline row and one for the boundary escalation.

Route: zai-org/GLM-5.3-Flash through https://api.featherless.ai/v1, prompt JSON,
32768 output tokens, low reasoning effort; 17 shared parity fields are equal.
Harness v2, code commit `0c515300675e6a1e9550db90f29d5fa3420d95c3`, project `day0-v4-glm53flash-1a2075`.
`v4` is the paired rerun's evidence-generation label after the v3 hosted beds; it is
not a harness-version change. The `-pilot` suffix keeps its six rows out of the full bed.

`backend-run.log.gz` is the redacted backend watcher for the pilot window only.
`run.log` is the redacted nohup driver log. All model calls used the shipped code.
