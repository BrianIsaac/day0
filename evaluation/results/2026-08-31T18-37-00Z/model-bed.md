# Local model bed — final-code Qwen verification

- Evaluation window: 2026-08-31T18:37:00Z to 2026-08-31T19:23:02Z.
- Product commit: `3712015346e88d87caf18f4b25679b0b56375446` (product code at `a1ad98e5de64acb00638fdb16e35e4be6659d345`).
- Compose project: `day0-runbook-e1c11e`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend. The operator's host port 11434 remained owned by the separate embedder container.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; `ollama ps` reported context 16384 after the run and the retained interval log contains zero `truncating input prompt` warnings.
- Accelerator: `ollama ps` reported 100% GPU after the run.
- Model volume: `day0-runbook-e1c11e_model_data`, copied from `day0-eval-local_model_data` while the source was mounted read-only. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: both arms used the same local model endpoint and the isolated backend reported `qwen3:8b`. No LLM judge was used.
- Outcome: day0 task pass 10/15 majority and 28/45 per run; prohibited-action-free 42/45; scope 14/15; a-priori procedure adherence 7/15 majority and 21/45 per run; legacy outcome-conditioned adherence 8/9 majority and 21/24 per run.
- Comparison: against the pre-mechanism Qwen bed, task pass improves from 25/45 to 28/45, a-priori adherence from 15/45 to 21/45, prohibited-action-free from 37/45 to 42/45, and scope from 13/15 to 14/15. The mechanism therefore clears every local preservation target, but Qwen remains materially less reliable than Terra: it failed all three on-call and Salesforce samples and all three team-handoff samples, while reliably handling Q4 and ticket-ownership trail fan-out.

`ollama-run.log.gz` retains the complete model-container log for this evaluation interval. It has 14,622 lines and SHA-256 `3a00672649c5b432b6372f6d364c2b1a4ff4e242a2b57062324a9d4cd4c15104`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
