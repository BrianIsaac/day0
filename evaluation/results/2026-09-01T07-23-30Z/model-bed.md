# Local model bed — frozen final evaluation

- Evaluation window: 2026-09-01T07:23:20Z to 2026-09-01T08:11:04Z.
- Frozen commit: `6a25a27b51ee8957a377e287a9580d022c2912db`.
- Compose project: `day0-final-eval-a72e8a`; no `day0`, `day0-eval`, or `day0-eval-local` container was started.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend. Host port 11434 remained owned by the operator's embedder.
- Context and accelerator: `OLLAMA_CONTEXT_LENGTH=16384`; post-run `ollama ps` reported context 16,384 and 100% GPU.
- Bed: both arms, all 15 fixed tasks, `n=3`, temperature 0.4, no LLM judge. The harness recorded and asserted equal model and harness parameters before execution; the only whitelisted arm differences were the onboarding pipeline and governed execution turn.
- Denominators: 45 task-runs and 15 task majorities per arm; a-priori documented-procedure adherence also used 45 task-runs and 15 task majorities per arm.
- Result: day0 passed 6/15 tasks by majority and 22/45 per run; baseline passed 8/15 and 23/45. Day0 was prohibited-action-free on 41/45 task-runs versus 38/45, and adhered to documented procedure on 6/15 majorities and 17/45 task-runs versus 2/15 and 5/45.
- Recorded capability finding: day0's `scope-hr-decision` failed all three repetitions; run 3 reached the fixed 180-second task timeout. This is retained as a model outcome and was not changed or retried.
- Provider isolation: both arms and the isolated backend reported `qwen3:8b`; the backend used the bundled model endpoint. The copied Daytona credentials were removed from the isolated deployment before evaluation, and skill verification used the local sandbox.

`ollama-run.log.gz` retains the complete model-container log for the evaluation interval. It contains 16,194 lines, has zero `truncating input prompt` warnings, and has SHA-256 `a82c4dbf85be53f067efafbbf9830536c52b8097f527edffd9eee21b4864aeb7`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
