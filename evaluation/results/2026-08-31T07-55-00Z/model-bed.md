# Local model bed

- Evaluation window: 2026-08-31T07:56:24Z to 2026-08-31T08:40:10Z.
- Product commit: `050a9c90138ef28c82636848c61abedc6e6c19f7`.
- Compose project: `day0-purity-77ef43`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; the retained log records `n_ctx = 16384` and zero `truncating input prompt` warnings.
- Accelerator: all 37/37 layers offloaded to the RTX 5070 Ti Laptop GPU; `ollama ps` reported 100% GPU at context 16384 during the run.
- Model volume: copied into `day0-purity-77ef43_model_data` from `day0-eval-local_model_data` mounted read-only. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: both the worktree and backend named the local model endpoint, the backend reported `qwen3:8b`, and the only model-container traffic retained for this bed is in the log below. No LLM judge was used.

`ollama-run.log.gz` is the complete model-container log from creation through the end of the evaluation. It has 15,298 lines and SHA-256 `e79fbc784c50a127ff58a59f6aefbbaae2264ed1d70966ee8e166e13fd61abb6`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
zgrep -E 'llama_context: n_ctx|offloaded [0-9]+/[0-9]+ layers' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
