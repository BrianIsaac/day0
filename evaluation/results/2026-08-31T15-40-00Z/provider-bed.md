# Hosted provider bed — regression finding

- Evaluation window: approximately 2026-08-31T15:40:00Z to 2026-08-31T16:11:33Z.
- Product commit: `5c0beaa37f778de904bd687fe8b8b725886588da`.
- Compose project: `day0-runbook-e1c11e`; the isolated backend was healthy on host port 35120 and its local-model container was stopped before this run.
- Model: `gpt-5.6-terra` through the default OpenAI endpoint. The backend had no `OPENAI_BASE_URL`; context and seed were provider-managed.
- Shared settings: temperature 0.4, JSON mode `auto`, 90-second per-call abort deadline, task-specific deadlines, provider retry limit 2, and the shared bounded outer transient-retry policy. The harness asserted every recorded setting equal across arms before starting.
- Completeness: both arms, all 15 tasks, three runs, 6/6 configured runs and 45/45 task outcomes per arm. No LLM judge was used.
- Outcome: day0 task pass 12/15 majority and 36/45 per run; prohibited-action-free 39/45; scope 12/15; a-priori procedure adherence 10/15 majority and 30/45 per run; legacy outcome-conditioned adherence 10/11 majority and 29/31 per run.
- Finding: all 15 approval-write outcomes passed, but task pass, prohibited-action-free and scope regressed against the purity bed. The runtime action-count floor treated an unresolved message destination as distinct from the document-derived manager destination, forcing a second mutation. Cadence and first-week runs filled the artificial slot with unrelated ticket actions; HR filled it with the prohibited requested public post. This bed is retained and rejected, and its finding must be fixed rather than traded for adherence.

The report’s harness-parity table is the recorded provider configuration for both arms.
