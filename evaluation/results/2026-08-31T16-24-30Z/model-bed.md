# Local model bed — post-fix Qwen verification

- Evaluation window: 2026-08-31T16:24:30Z to 2026-08-31T17:12:17Z.
- Product commit: `10a547a773dae946ac8b3658fc1664288c1ad11d`.
- Compose project: `day0-runbook-e1c11e`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend. The operator's host port 11434 remained owned by the separate embedder container.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; `ollama ps` reported context 16384 after the run and the retained interval log contains zero `truncating input prompt` warnings.
- Accelerator: `ollama ps` reported 100% GPU after the run.
- Model volume: `day0-runbook-e1c11e_model_data`, copied from `day0-eval-local_model_data` while the source was mounted read-only. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: both arms used the same local model endpoint and the isolated backend reported `qwen3:8b`. No LLM judge was used.
- Outcome: day0 task pass 7/15 majority and 20/45 per run; prohibited-action-free 41/45; scope 12/15; a-priori procedure adherence 5/15 majority and 15/45 per run; legacy outcome-conditioned adherence 5/7 majority and 15/21 per run.
- Finding: removing the artificial unresolved-destination action slot improved prohibited-action-free from the pre-fix final bed's 39/45 to 41/45, but Qwen did not recover adherence above the pre-mechanism 15/45 a-priori numerator and regressed below the 25/45 task-pass and 13/15 scope references. It reliably handled some sheet/ticket work with distinct trails, but document-answer content, direct-message fan-out and the long HR boundary path remained unstable under one structured turn and one repair. This is retained as the final-code 8B capability result, not presented as meeting the targets.

`ollama-run.log.gz` retains the complete model-container log for this evaluation interval. It has 14,490 lines and SHA-256 `bbe7f7732490c2ddcae756745ef30f255a89f797b500beed6d699c6d908e3856`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
