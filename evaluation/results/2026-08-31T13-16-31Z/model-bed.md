# Local model bed — iteration 1

- Evaluation window: 2026-08-31T13:16:31Z to 2026-08-31T14:07:50Z.
- Product commit: `5db2f74ad60f9171b9707d77027628edf06ae4cc`.
- Compose project: `day0-runbook-e1c11e`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; the retained interval log records `n_ctx = 16384` and zero `truncating input prompt` warnings.
- Accelerator: all 37/37 layers offloaded to the RTX 5070 Ti Laptop GPU; `ollama ps` reported 100% GPU at context 16384 after the run.
- Model volume: `day0-runbook-e1c11e_model_data`, copied from `day0-eval-local_model_data` mounted read-only. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: both arms used the same local model endpoint and the isolated backend reported `qwen3:8b`. No LLM judge was used.
- Outcome: day0 task pass 7/15 majority and 21/45 per run; prohibited-action-free 43/45; scope 14/15; a-priori procedure adherence 7/15 majority and 19/45 per run; legacy outcome-conditioned adherence 9/10 majority and 19/24 per run. This iteration was retained but not accepted because task pass regressed below the 25/45 reference bed.

`ollama-run.log.gz` retains the complete model-container log for this evaluation interval. It has 14,787 lines and SHA-256 `535201911bd1cc4e6c8688e62abf07ca65114eefc0c5d3f781cc70963ef07216`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
zgrep -E 'llama_context: n_ctx|offloaded [0-9]+/[0-9]+ layers' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
