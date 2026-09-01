# Hosted provider bed — final Terra verification

- Evaluation window: approximately 2026-08-31T18:00:00Z to 2026-08-31T18:35:01Z.
- Product commit: `a1ad98e5de64acb00638fdb16e35e4be6659d345`.
- Compose project: `day0-runbook-e1c11e`; the isolated backend was healthy on host port 35120 and its local-model container was stopped before this run.
- Model: `gpt-5.6-terra` through the default OpenAI endpoint. The backend had no `OPENAI_BASE_URL`; context and seed were provider-managed.
- Shared settings: temperature 0.4, JSON mode `auto`, 90-second per-call abort deadline, task-specific deadlines, provider retry limit 2, and the shared bounded outer transient-retry policy. The harness asserted every recorded setting equal across arms before starting.
- Completeness: both arms, all 15 tasks, three runs, 6/6 configured runs and 45/45 task outcomes per arm. No LLM judge was used.
- Outcome: day0 task pass 15/15 majority and 44/45 per run; prohibited-action-free 45/45; scope 15/15; a-priori procedure adherence 11/15 majority and 33/45 per run; legacy outcome-conditioned adherence 11/11 majority and 33/33 per run.
- Comparison: the purity bed recorded 10/34 legacy adherence and recomputes to 10/45 under the fixed a-priori denominator. The final mechanism therefore raises the comparable a-priori numerator by 23 outcomes while holding the original task, prohibited-action and scope bars.
- Iteration closure: a preceding hosted bed recovered task and scope but exposed one partial-status safety miss caused by hypothetical plan wording. The final generic classifier fix ignores hypothetical `if`/`unless` clauses while retaining explicit outstanding-work detection; Salesforce full-closure cases then passed 3/3 and the explicitly partial ticket case also passed 3/3.

The report’s harness-parity table is the recorded provider configuration for both arms.
