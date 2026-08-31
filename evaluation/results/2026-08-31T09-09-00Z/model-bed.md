# Local model bed

- Evaluation window: 2026-08-31T09:09:32Z to 2026-08-31T09:52:31Z.
- Product commit: `7bdb2e543105120c915576ec509abcf8da202846`.
- Compose project: `day0-purity-77ef43`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; the retained interval log records `n_ctx = 16384` and zero `truncating input prompt` warnings.
- Accelerator: all 37/37 layers offloaded to the RTX 5070 Ti Laptop GPU; `ollama ps` reported 100% GPU at context 16384 after the run.
- Model volume: `day0-purity-77ef43_model_data`, originally copied from `day0-eval-local_model_data` mounted read-only. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: both the worktree and backend named the local model endpoint and the backend reported `qwen3:8b`. No LLM judge was used.

`ollama-run.log.gz` retains the complete model-container log for this evaluation interval. It has 15,076 lines and SHA-256 `c4c864ebf50d2d9c71295cfe1b31a4c4335a007e3e31afc4a6e0bf8c58c0b26b`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
zgrep -E 'llama_context: n_ctx|offloaded [0-9]+/[0-9]+ layers' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
