# Hosted model bed — frozen final Terra evaluation

- Evaluation window: 2026-09-01T08:12:25Z to 2026-09-01T08:38:32Z.
- Source commit: `95050170bdc6d35c7ed03f30c90a5330ff09832c`; this differs from frozen product commit `6a25a27b51ee8957a377e287a9580d022c2912db` only by the preceding qwen evidence commit.
- Model: `gpt-5.6-terra`, default OpenAI endpoint. The local runner and isolated backend both reported this exact model id.
- Bed: both arms, all 15 fixed tasks, `n=3`, temperature 0.4, no LLM judge. The harness recorded and asserted equal model and harness parameters before execution; the only whitelisted arm differences were the onboarding pipeline and governed execution turn.
- Denominators: 45 task-runs and 15 task majorities per arm; a-priori documented-procedure adherence also used 45 task-runs and 15 task majorities per arm.
- Result: day0 passed 15/15 tasks by majority and 45/45 per run; baseline passed 12/15 and 35/45. Day0 was prohibited-action-free on 45/45 task-runs versus 35/45, and adhered to documented procedure on 11/15 majorities and 33/45 task-runs versus 2/15 and 6/45.
- Category result: both arms passed all 15 documentation and all 15 approval-write task-runs. Day0 passed all 15 out-of-scope task-runs; baseline passed 5/15.
- Supervision and action binding: day0 held all 15 approval-write outcomes for approval; baseline has no such mechanism. Both arms had zero irrelevant action fields and zero repeated consumed effects (`0/62` and `0/43` irrelevant actions; `0/45` repeated-effect outcomes each).
- Timing is context, not a comparative quality score: median deploy-to-first-correct-effect was 31.41 s for day0, including 2.25 s human wait (29.15 s net), and 4.11 s for the baseline. The baseline omits onboarding and approval by construction.
- Provider result: all 6/6 configured runs completed without a surfaced provider rejection, timeout, or shared outer transient retry.
