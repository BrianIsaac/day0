# Local model bed

- Evaluation window: 2026-08-31T05:08:16Z to 2026-08-31T05:53:27Z.
- Compose project: `day0-outperform-1e8669`.
- Model: `qwen3:8b`, served by the bundled Ollama container on host port 11435 and `http://model:11434/v1` from the isolated backend.
- Context: `OLLAMA_CONTEXT_LENGTH=16384`; the retained log records `n_ctx = 16384` and zero `truncating input prompt` warnings.
- Accelerator: all 37/37 layers offloaded to the RTX 5070 Ti Laptop GPU; `ollama ps` reported 100% GPU after load.
- Model volume: copied into `day0-outperform-1e8669_model_data` with `day0-eval-local_model_data` mounted read-only for the copy. The evaluation backend, sandbox socket and network were project-scoped.
- Provider isolation: the worktree and backend both named the local endpoint, the backend reported `qwen3:8b`, and `OPENAI_API_KEY` was absent before the run. No hosted provider or LLM judge was used.

`ollama-run.log.gz` is the complete model-container log for the interval. It has 14,316 lines and SHA-256 `7e13b8841642a9ad176411099c31e0dfe6d7142bdb310c44c2260dbd98a6ed14`.

Verification:

```bash
zgrep -c 'truncating input prompt' ollama-run.log.gz
zgrep -E 'llama_context: n_ctx|offloaded [0-9]+/[0-9]+ layers' ollama-run.log.gz
sha256sum ollama-run.log.gz
```
