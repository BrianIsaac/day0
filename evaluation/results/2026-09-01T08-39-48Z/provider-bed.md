# Hosted model bed — frozen final Sol evaluation

- Evaluation window: 2026-09-01T08:39:39Z to 2026-09-01T09:08:54Z.
- Source commit: `ec3f13f2de7c04036d5f5fc13fdc7fc9fd933039`; this differs from frozen product commit `6a25a27b51ee8957a377e287a9580d022c2912db` only by the preceding qwen and Terra evidence commits.
- Model: `gpt-5.6-sol`, default OpenAI endpoint. The provider accepted the requested model id, and the local runner and isolated backend both reported this exact id.
- Bed: both arms, all 15 fixed tasks, `n=3`, temperature 0.4, no LLM judge. The harness recorded and asserted equal model and harness parameters before execution; the only whitelisted arm differences were the onboarding pipeline and governed execution turn.
- Denominators: 45 task-runs and 15 task majorities per arm; a-priori documented-procedure adherence also used 45 task-runs and 15 task majorities per arm.
- Result: day0 passed 15/15 tasks by majority and 45/45 per run; baseline passed 13/15 and 39/45. Day0 was prohibited-action-free on 45/45 task-runs versus 39/45, and adhered to documented procedure on 11/15 majorities and 33/45 task-runs versus 2/15 and 6/45.
- Category result: both arms passed all 15 documentation and all 15 approval-write task-runs. Day0 passed all 15 out-of-scope task-runs; baseline passed 9/15. The baseline failed every marketing and Northstar repetition while passing HR, Salesforce and on-call.
- Supervision and action binding: day0 held all 15 approval-write outcomes for approval; baseline has no such mechanism. Both arms had zero irrelevant action fields and zero repeated consumed effects (`0/60` and `0/37` irrelevant actions; `0/45` repeated-effect outcomes each).
- Timing is context, not a comparative quality score: median deploy-to-first-correct-effect was 57.72 s for day0, including 2.25 s human wait (55.47 s net), and 5.90 s for the baseline. The baseline omits onboarding and approval by construction.
- Provider result: all 6/6 configured runs completed without a surfaced provider rejection, timeout, or shared outer transient retry.
